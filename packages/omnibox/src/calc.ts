import { convertPhrase, FUNCTIONS, formatSI, parseUnit, toSignificant } from '@aether/calculators';

/**
 * Unit-aware calculator for the address bar:
 *   "= 3.3V / 470ohm in mA"   -> 7.021 mA
 *   "12 kN*m to lbf*ft"       -> 8851 lbf*ft
 *   "255 to hex", "0b1010 + 3", "sin(30 deg)", "10k || 10k"
 *
 * Values are carried in SI with a dimension vector, so adding volts to
 * amps is an error rather than a wrong number. Built on the unit table and
 * functions of @aether/calculators; no eval.
 */

type Dim = number[];
interface Q {
  v: number;
  d: Dim;
}

export interface CalcResult {
  /** Formatted answer, e.g. "7.021 mA". */
  text: string;
  /** Plain value to copy (no thousands separators). */
  copy: string;
}

const ZERO: Dim = [0, 0, 0, 0, 0, 0, 0, 0, 0];
const RAD = 8;
const dimless = (d: Dim) => d.every((x, i) => Math.abs(x) < 1e-12 || i === RAD);
const sameDim = (a: Dim, b: Dim) => a.every((x, i) => Math.abs(x - b[i]!) < 1e-12);
const num = (v: number): Q => ({ v, d: ZERO });

const unitQ = (sym: string): Q | null => {
  try {
    const p = parseUnit(sym);
    return { v: p.factor, d: p.dim };
  } catch {
    return null;
  }
};

// Physical constants with their units, so dimensions stay honest.
const CONST: Record<string, [number, string]> = {
  pi: [Math.PI, '1'],
  tau: [2 * Math.PI, '1'],
  e: [Math.E, '1'],
  c: [299_792_458, 'm/s'],
  q: [1.602_176_634e-19, 'C'],
  kB: [1.380_649e-23, 'J/K'],
  h: [6.626_070_15e-34, 'J*s'],
  eps0: [8.854_187_8128e-12, 'F/m'],
  mu0: [1.256_637_062_12e-6, 'H/m'],
  g0: [9.806_65, 'm/s^2'],
  NA: [6.022_140_76e23, '1/mol'],
  R: [8.314_462_618, 'J/mol/K'],
  G: [6.674_3e-11, 'm^3/kg/s^2'],
};
const constQ = (name: string): Q | null => {
  const c = Object.hasOwn(CONST, name) ? CONST[name] : undefined;
  if (!c) return null;
  return { v: c[0], d: c[1] === '1' ? ZERO : parseUnit(c[1]).dim };
};

const SI_SUFFIX: Record<string, number> = { T: 1e12, G: 1e9, M: 1e6, meg: 1e6, k: 1e3, K: 1e3, m: 1e-3, u: 1e-6, µ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };

type Tok = { t: 'num'; v: number; glued: boolean } | { t: 'id'; v: string; glued: boolean } | { t: 'op'; v: string } | { t: 'end' };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let prevNum = false;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      prevNum = false;
      continue;
    }
    const rest = src.slice(i);
    const radix = /^0([xXbBoO])([0-9a-fA-F_]+)/.exec(rest);
    if (radix) {
      const base = { x: 16, b: 2, o: 8 }[radix[1]!.toLowerCase() as 'x' | 'b' | 'o'];
      const digits = radix[2]!.replace(/_/g, '');
      const v = parseInt(digits, base);
      if (Number.isNaN(v) || !new RegExp(`^[${'0123456789abcdef'.slice(0, base)}]+$`, 'i').test(digits)) throw new Error(`Bad number "${radix[0]}"`);
      out.push({ t: 'num', v, glued: false });
      i += radix[0].length;
      prevNum = true;
      continue;
    }
    const n = /^(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (n) {
      out.push({ t: 'num', v: parseFloat(n[0].replace(/_/g, '')), glued: false });
      i += n[0].length;
      prevNum = true;
      continue;
    }
    const id = /^(?:°[CF]?|[A-Za-z_µμΩ][A-Za-z_\dµμΩ]*)/.exec(rest);
    if (id) {
      out.push({ t: 'id', v: id[0], glued: prevNum });
      i += id[0].length;
      prevNum = false;
      continue;
    }
    if (rest.startsWith('||') || rest.startsWith('**')) {
      out.push({ t: 'op', v: rest.startsWith('**') ? '^' : '||' });
      i += 2;
      prevNum = false;
      continue;
    }
    if ('²³'.includes(c)) {
      out.push({ t: 'op', v: '^' }, { t: 'num', v: c === '²' ? 2 : 3, glued: false });
      i++;
      continue;
    }
    if ('+-*/^%(),×÷·⋅'.includes(c)) {
      out.push({ t: 'op', v: c === '×' || c === '·' || c === '⋅' ? '*' : c === '÷' ? '/' : c });
      i++;
      prevNum = false;
      continue;
    }
    throw new Error(`Unexpected "${c}"`);
  }
  out.push({ t: 'end' });
  return out;
}

const add = (a: Q, b: Q, sign: 1 | -1): Q => {
  if (!sameDim(a.d, b.d)) throw new Error('Cannot add quantities with different units');
  return { v: a.v + sign * b.v, d: a.d };
};
const mul = (a: Q, b: Q, p: 1 | -1): Q => ({ v: p === 1 ? a.v * b.v : a.v / b.v, d: a.d.map((x, i) => x + p * b.d[i]!) });
const pow = (a: Q, b: Q): Q => {
  if (!dimless(b.d)) throw new Error('Exponent must be a plain number');
  return { v: a.v ** b.v, d: a.d.map((x) => x * b.v) };
};

/** Functions that keep the unit of their (same-unit) arguments. */
const SAME_UNIT = new Set(['abs', 'min', 'max', 'hypot', 'par', 'round', 'floor', 'ceil']);

function evaluate(src: string): Q {
  const toks = tokenize(src);
  let k = 0;
  const peek = () => toks[k]!;
  const isOp = (v: string) => {
    const t = peek();
    return t.t === 'op' && t.v === v;
  };
  const take = () => toks[k++]!;

  const parallel = (): Q => {
    let a = additive();
    while (isOp('||')) {
      take();
      const b = additive();
      if (!sameDim(a.d, b.d)) throw new Error('|| needs matching units');
      a = { v: (a.v * b.v) / (a.v + b.v), d: a.d };
    }
    return a;
  };
  const additive = (): Q => {
    let a = multiplicative();
    for (;;) {
      if (isOp('+')) (take(), (a = add(a, multiplicative(), 1)));
      else if (isOp('-')) (take(), (a = add(a, multiplicative(), -1)));
      else return a;
    }
  };
  const multiplicative = (): Q => {
    let a = unary();
    for (;;) {
      if (isOp('*')) (take(), (a = mul(a, unary(), 1)));
      else if (isOp('/')) (take(), (a = mul(a, unary(), -1)));
      else if (isOp('%')) {
        take();
        const b = unary();
        if (!sameDim(a.d, b.d)) throw new Error('% needs matching units');
        a = { v: a.v % b.v, d: a.d };
      } else return a;
    }
  };
  const unary = (): Q => {
    if (isOp('-')) {
      take();
      const a = unary();
      return { v: -a.v, d: a.d };
    }
    if (isOp('+')) {
      take();
      return unary();
    }
    return power();
  };
  const power = (): Q => {
    const base = primary();
    if (isOp('^')) {
      take();
      return pow(base, unary());
    }
    return base;
  };
  const call = (name: string): Q => {
    const f = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name]! : undefined;
    if (!f) throw new Error(`Unknown function "${name}"`);
    take(); // (
    const args: Q[] = [];
    if (!isOp(')')) {
      args.push(parallel());
      while (isOp(',')) (take(), args.push(parallel()));
    }
    if (!isOp(')')) throw new Error('Missing ")"');
    take();
    const [lo, hi] = Array.isArray(f.arity) ? f.arity : [f.arity, f.arity];
    if (args.length < lo || args.length > hi) throw new Error(`${name}() takes ${lo === hi ? lo : `${lo}+`} argument(s)`);
    if (name === 'sqrt' || name === 'cbrt') return pow(args[0]!, num(name === 'sqrt' ? 0.5 : 1 / 3));
    if (SAME_UNIT.has(name)) {
      if (!args.every((a) => sameDim(a.d, args[0]!.d))) throw new Error(`${name}() needs matching units`);
      const plain = args.map((a) => a.v);
      return { v: name === 'round' ? Math.round(plain[0]!) : f.fn(...plain), d: args[0]!.d };
    }
    if (!args.every((a) => dimless(a.d))) throw new Error(`${name}() needs plain numbers or angles`);
    return num(f.fn(...args.map((a) => a.v)));
  };
  const primary = (): Q => {
    const t = take();
    if (t.t === 'num') {
      const next = peek();
      // A unit or SI suffix written right after a number: "470ohm", "4.7k", "3.3 V".
      if (next.t === 'id' && !(toks[k + 1]?.t === 'op' && (toks[k + 1] as { v: string }).v === '(')) {
        const u = unitQ(next.v);
        if (u) {
          take();
          let unit = u;
          if (isOp('^') && toks[k + 1]?.t === 'num') {
            take();
            unit = pow(u, num((take() as { v: number }).v));
          }
          return mul(num(t.v), unit, 1);
        }
        if (next.glued && Object.hasOwn(SI_SUFFIX, next.v)) {
          take();
          return num(t.v * SI_SUFFIX[next.v]!);
        }
      }
      return num(t.v);
    }
    if (t.t === 'op' && t.v === '(') {
      const v = parallel();
      if (!isOp(')')) throw new Error('Missing ")"');
      take();
      return v;
    }
    if (t.t === 'id') {
      if (isOp('(')) return call(t.v);
      const q = constQ(t.v) ?? unitQ(t.v);
      if (q) return q;
      throw new Error(`Unknown name "${t.v}"`);
    }
    throw new Error(t.t === 'end' ? 'Incomplete expression' : `Unexpected "${(t as { v: string }).v}"`);
  };

  const q = parallel();
  if (peek().t !== 'end') throw new Error('Unexpected input');
  return q;
}

// Units tried, in order, when no target unit is given. Prefixable ones get SI prefixes.
const DISPLAY: [string, boolean][] = [
  ['V', true], ['A', true], ['Ω', true], ['W', true], ['J', true], ['N', true], ['Pa', true], ['Hz', true],
  ['F', true], ['H', true], ['C', true], ['T', true], ['Wb', true], ['S', true], ['m', true], ['g', true],
  ['s', true], ['K', false], ['mol', false], ['bit', false], ['m/s', false], ['m/s^2', false], ['m^2', false], ['m^3', false],
  ['N*m', false], ['V/m', false], ['A/m^2', false], ['kg/m^3', false], ['W/m^2', false],
];
const BASE = ['m', 'kg', 's', 'A', 'K', 'mol', 'cd', 'bit', 'rad'];

const plain = (x: number, sig = 10) => {
  if (!Number.isFinite(x)) return String(x);
  const r = toSignificant(x, sig);
  return Math.abs(r) >= 1e15 || (Math.abs(r) < 1e-6 && r !== 0) ? r.toExponential() : String(r);
};
const grouped = (x: number, sig = 10) => {
  const s = plain(x, sig);
  return /e/.test(s) ? s : s.replace(/^(-?\d+)/, (m) => m.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
};

function formatQ(q: Q): CalcResult {
  if (dimless(q.d) && Math.abs(q.d[RAD]!) < 1e-12) return { text: grouped(q.v), copy: plain(q.v) };
  for (const [sym, prefixed] of DISPLAY) {
    const u = unitQ(sym)!;
    if (!sameDim(u.d, q.d)) continue;
    const x = q.v / u.v;
    if (prefixed) {
      // Mass is stored in kg; formatSI picks "kg", "g", "mg" from grams.
      const text = formatSI(x, sym, 4);
      return { text, copy: text.replace(/\s/g, '') };
    }
    const text = `${toSignificant(x, 6)} ${sym}`;
    return { text, copy: text.replace(/\s/g, '') };
  }
  const parts = BASE.map((b, i) => [b, q.d[i]!] as const).filter(([, p]) => Math.abs(p) > 1e-12);
  const num_ = parts.filter(([, p]) => p > 0).map(([b, p]) => (p === 1 ? b : `${b}^${toSignificant(p, 4)}`));
  const den = parts.filter(([, p]) => p < 0).map(([b, p]) => (p === -1 ? b : `${b}^${toSignificant(-p, 4)}`));
  const unit = `${num_.join('·') || '1'}${den.length ? `/${den.length > 1 ? `(${den.join('·')})` : den[0]}` : ''}`;
  const text = `${toSignificant(q.v, 6)} ${unit}`;
  return { text, copy: text };
}

function toRadix(q: Q, target: string): CalcResult {
  if (!dimless(q.d) || !Number.isInteger(q.v)) throw new Error('Only whole numbers convert to hex/bin/oct');
  const base = target.startsWith('hex') ? 16 : target.startsWith('bin') ? 2 : target.startsWith('oct') ? 8 : 10;
  const bits = Number(target.replace(/^\D+/, '')) || (q.v < 0 ? 32 : 0);
  let v = BigInt(q.v);
  let note = '';
  if (v < 0n) {
    if (bits > 64) throw new Error('Width must be at most 64 bits');
    v = (1n << BigInt(bits)) + v;
    if (v < 0n) throw new Error(`Does not fit in ${bits} bits`);
    note = ` (${bits}-bit two's complement)`;
  } else if (bits && v >= 1n << BigInt(bits)) throw new Error(`Does not fit in ${bits} bits`);
  const prefix = base === 16 ? '0x' : base === 2 ? '0b' : base === 8 ? '0o' : '';
  let digits = v.toString(base);
  if (bits && base !== 10) digits = digits.padStart(Math.ceil(bits / Math.log2(base)), '0');
  if (base === 16) digits = digits.toUpperCase();
  if (base === 2) digits = digits.replace(/\B(?=(\d{4})+(?!\d))/g, '_');
  const copy = `${prefix}${digits.replace(/_/g, '')}`;
  return { text: `${prefix}${digits}${note}`, copy };
}

const TARGET_RE = /^(.*\S)\s+(?:to|in|as|->|=>)\s+(\S.*)$/i;
const RADIX_RE = /^(hex|bin|oct|dec)(8|16|32|64)?$/i;

/**
 * Evaluates `input` as a calculation. Returns null when it does not look
 * like one, so ordinary searches ("2024 olympics") are left alone.
 * A leading "=" forces calculator mode and surfaces errors.
 */
export function quickCalc(input: string): CalcResult | { error: string } | null {
  const forced = input.trimStart().startsWith('=');
  const src = input.trim().replace(/^=\s*/, '');
  if (!src || src.length > 300) return null;
  try {
    if (/°|deg[CF]\b/.test(src)) {
      const r = convertPhrase(src);
      if (r) {
        const text = `${toSignificant(r.result, 6)} ${r.to.trim()}`;
        return { text, copy: plain(r.result) };
      }
    }
    const m = TARGET_RE.exec(src);
    if (m) {
      const q = evaluate(m[1]!);
      const target = m[2]!.trim();
      if (RADIX_RE.test(target)) return toRadix(q, target.toLowerCase());
      if (/^(sci|eng)$/i.test(target)) {
        const text = q.v.toExponential(5);
        return { text, copy: text };
      }
      const u = parseUnit(target);
      if (!sameDim(u.dim, q.d)) throw new Error(`The result is not convertible to ${target}`);
      const x = q.v / u.factor;
      return { text: `${grouped(x, 6)} ${target}`, copy: plain(x) };
    }
    // Without "=", only treat it as maths if it has an operator or a function call.
    if (!forced && !/[-+*/^×÷%|²³]|\w\(/.test(src.replace(/^-/, ''))) return null;
    if (!forced && /^[\d\s-]+$/.test(src) && !/\d\s*-\s*\d/.test(src)) return null;
    return formatQ(evaluate(src));
  } catch (err) {
    return forced ? { error: err instanceof Error ? err.message : 'Cannot evaluate' } : null;
  }
}
