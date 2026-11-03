/**
 * A small, safe expression language for filters and derived columns.
 *
 *   price * qty > 1000 and lower(city) == "pune"
 *   if(isnull(age), median_age, age)
 *   `unit price` * 1.18
 *
 * It is parsed into an AST and interpreted; nothing is passed to eval() or
 * new Function(). Only the functions listed in FUNCTIONS exist. Length, depth
 * and node counts are bounded so a pasted expression cannot hang the app.
 */
import { type Cell, DataError, num } from './table.js';
import { dateValue } from './schema.js';

export type Node =
  | { k: 'lit'; v: Cell }
  | { k: 'col'; name: string }
  | { k: 'un'; op: '-' | 'not'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[] }
  | { k: 'list'; items: Node[] };

export const EXPR_LIMITS = { maxLength: 2000, maxDepth: 64, maxNodes: 1000 };

type Tok = { t: 'num' | 'str' | 'id' | 'col' | 'op' | 'eof'; v: string; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!;
      out.push({ t: 'num', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          j += 2;
          continue;
        }
        s += src[j++];
      }
      if (j >= src.length) throw new DataError('expr', `Unclosed string starting at ${i + 1}.`);
      out.push({ t: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (c === '`' || c === '[') {
      const close = c === '`' ? '`' : ']';
      const j = src.indexOf(close, i + 1);
      if (j < 0) throw new DataError('expr', `Unclosed column name starting at ${i + 1}.`);
      out.push({ t: 'col', v: src.slice(i + 1, j), pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_À-￿]/.test(c)) {
      const m = /^[A-Za-z_À-￿][A-Za-z0-9_.À-￿]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>=', '&&', '||', '<>'].includes(two)) {
      out.push({ t: 'op', v: two === '<>' ? '!=' : two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/%^<>()!,='.includes(c)) {
      out.push({ t: 'op', v: c === '=' ? '==' : c, pos: i });
      i++;
      continue;
    }
    throw new DataError('expr', `Unexpected character “${c}” at ${i + 1}.`);
  }
  out.push({ t: 'eof', v: '', pos: src.length });
  return out;
}

export function parseExpr(src: string): Node {
  if (typeof src !== 'string' || !src.trim()) throw new DataError('expr', 'Expression is empty.');
  if (src.length > EXPR_LIMITS.maxLength) throw new DataError('expr', `Expression is longer than ${EXPR_LIMITS.maxLength} characters.`);
  const toks = tokenize(src);
  let p = 0;
  let nodes = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek().t === 'op' && peek().v === v;
  const isWord = (v: string) => peek().t === 'id' && peek().v.toLowerCase() === v;
  const make = <T extends Node>(n: T): T => {
    if (++nodes > EXPR_LIMITS.maxNodes) throw new DataError('expr', 'Expression is too complex.');
    return n;
  };
  const enter = () => {
    if (++depth > EXPR_LIMITS.maxDepth) throw new DataError('expr', 'Expression is nested too deeply.');
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new DataError('expr', `Expected “${v}” at ${peek().pos + 1}.`);
    p++;
  };

  function or(): Node {
    let a = and();
    while (isOp('||') || isWord('or')) {
      p++;
      a = make({ k: 'bin', op: 'or', a, b: and() });
    }
    return a;
  }
  function and(): Node {
    let a = not();
    while (isOp('&&') || isWord('and')) {
      p++;
      a = make({ k: 'bin', op: 'and', a, b: not() });
    }
    return a;
  }
  function not(): Node {
    if (isOp('!') || isWord('not')) {
      p++;
      enter();
      const a = not();
      depth--;
      return make({ k: 'un', op: 'not', a });
    }
    return cmp();
  }
  function cmp(): Node {
    const a = add();
    if (peek().t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(peek().v)) {
      const op = toks[p++].v;
      return make({ k: 'bin', op, a, b: add() });
    }
    if (isWord('in')) {
      p++;
      expect('(');
      const items: Node[] = [];
      if (!isOp(')')) {
        items.push(or());
        while (isOp(',')) {
          p++;
          items.push(or());
        }
      }
      expect(')');
      return make({ k: 'bin', op: 'in', a, b: make({ k: 'list', items }) });
    }
    return a;
  }
  function add(): Node {
    let a = mul();
    while (isOp('+') || isOp('-')) {
      const op = toks[p++].v;
      a = make({ k: 'bin', op, a, b: mul() });
    }
    return a;
  }
  function mul(): Node {
    let a = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = toks[p++].v;
      a = make({ k: 'bin', op, a, b: unary() });
    }
    return a;
  }
  function unary(): Node {
    if (isOp('-')) {
      p++;
      enter();
      const a = unary();
      depth--;
      return make({ k: 'un', op: '-', a });
    }
    if (isOp('+')) {
      p++;
      return unary();
    }
    return pow();
  }
  function pow(): Node {
    const a = primary();
    if (isOp('^')) {
      p++;
      enter();
      const b = unary();
      depth--;
      return make({ k: 'bin', op: '^', a, b });
    }
    return a;
  }
  function primary(): Node {
    const t = peek();
    if (t.t === 'num') {
      p++;
      return make({ k: 'lit', v: Number(t.v) });
    }
    if (t.t === 'str') {
      p++;
      return make({ k: 'lit', v: t.v });
    }
    if (t.t === 'col') {
      p++;
      return make({ k: 'col', name: t.v });
    }
    if (t.t === 'id') {
      p++;
      const low = t.v.toLowerCase();
      if (isOp('(')) {
        if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, low)) throw new DataError('expr', `Unknown function “${t.v}”. Available: ${Object.keys(FUNCTIONS).join(', ')}.`);
        p++;
        enter();
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(or());
          while (isOp(',')) {
            p++;
            args.push(or());
          }
        }
        expect(')');
        depth--;
        const spec = FUNCTIONS[low];
        if (args.length < spec.min || args.length > spec.max) throw new DataError('expr', `${low}() takes ${spec.min === spec.max ? spec.min : `${spec.min}–${spec.max}`} arguments.`);
        return make({ k: 'call', fn: low, args });
      }
      if (low === 'true') return make({ k: 'lit', v: true });
      if (low === 'false') return make({ k: 'lit', v: false });
      if (low === 'null' || low === 'none') return make({ k: 'lit', v: null });
      return make({ k: 'col', name: t.v });
    }
    if (isOp('(')) {
      p++;
      enter();
      const e = or();
      depth--;
      expect(')');
      return e;
    }
    throw new DataError('expr', t.t === 'eof' ? 'Expression ended unexpectedly.' : `Unexpected “${t.v}” at ${t.pos + 1}.`);
  }
  const root = or();
  if (peek().t !== 'eof') throw new DataError('expr', `Unexpected “${peek().v}” at ${peek().pos + 1}.`);
  return root;
}

export function columnsUsed(n: Node, out = new Set<string>()): Set<string> {
  switch (n.k) {
    case 'col':
      out.add(n.name);
      break;
    case 'un':
      columnsUsed(n.a, out);
      break;
    case 'bin':
      columnsUsed(n.a, out);
      columnsUsed(n.b, out);
      break;
    case 'call':
      n.args.forEach((a) => columnsUsed(a, out));
      break;
    case 'list':
      n.items.forEach((a) => columnsUsed(a, out));
      break;
  }
  return out;
}

const str = (v: Cell): string => (v === null ? '' : String(v));
const nOrNull = (x: number): Cell => (Number.isFinite(x) ? x : null);
const truthy = (v: Cell): boolean => (v === null ? false : typeof v === 'string' ? v !== '' : Boolean(v));
const isNull = (v: Cell): boolean => v === null || (typeof v === 'string' && v.trim() === '');

function numArg(v: Cell): number {
  return num(v);
}

interface Fn {
  min: number;
  max: number;
  f: (args: Cell[]) => Cell;
  py: (args: string[]) => string;
}

const date = (v: Cell): Date | null => {
  const d = dateValue(v);
  return Number.isNaN(d) ? null : new Date(d);
};

export const FUNCTIONS: Record<string, Fn> = {
  abs: { min: 1, max: 1, f: ([a]) => nOrNull(Math.abs(numArg(a))), py: ([a]) => `${a}.abs()` },
  sqrt: { min: 1, max: 1, f: ([a]) => nOrNull(Math.sqrt(numArg(a))), py: ([a]) => `np.sqrt(${a})` },
  log: { min: 1, max: 1, f: ([a]) => nOrNull(Math.log(numArg(a))), py: ([a]) => `np.log(${a})` },
  log10: { min: 1, max: 1, f: ([a]) => nOrNull(Math.log10(numArg(a))), py: ([a]) => `np.log10(${a})` },
  log1p: { min: 1, max: 1, f: ([a]) => nOrNull(Math.log1p(numArg(a))), py: ([a]) => `np.log1p(${a})` },
  exp: { min: 1, max: 1, f: ([a]) => nOrNull(Math.exp(numArg(a))), py: ([a]) => `np.exp(${a})` },
  round: { min: 1, max: 2, f: ([a, d]) => { const k = 10 ** Math.max(0, Math.min(12, Math.trunc(numArg(d ?? 0)) || 0)); return nOrNull(Math.round(numArg(a) * k) / k); }, py: ([a, d]) => `${a}.round(${d ?? 0})` },
  floor: { min: 1, max: 1, f: ([a]) => nOrNull(Math.floor(numArg(a))), py: ([a]) => `np.floor(${a})` },
  ceil: { min: 1, max: 1, f: ([a]) => nOrNull(Math.ceil(numArg(a))), py: ([a]) => `np.ceil(${a})` },
  min: { min: 2, max: 8, f: (xs) => nOrNull(Math.min(...xs.map(numArg))), py: (xs) => `pd.concat([${xs.join(', ')}], axis=1).min(axis=1)` },
  max: { min: 2, max: 8, f: (xs) => nOrNull(Math.max(...xs.map(numArg))), py: (xs) => `pd.concat([${xs.join(', ')}], axis=1).max(axis=1)` },
  clip: { min: 3, max: 3, f: ([x, lo, hi]) => nOrNull(Math.min(numArg(hi), Math.max(numArg(lo), numArg(x)))), py: ([x, lo, hi]) => `${x}.clip(${lo}, ${hi})` },
  num: { min: 1, max: 1, f: ([a]) => nOrNull(numArg(a)), py: ([a]) => `pd.to_numeric(${a}, errors="coerce")` },
  str: { min: 1, max: 1, f: ([a]) => (a === null ? null : String(a)), py: ([a]) => `${a}.astype("string")` },
  lower: { min: 1, max: 1, f: ([a]) => (a === null ? null : str(a).toLowerCase()), py: ([a]) => `${a}.str.lower()` },
  upper: { min: 1, max: 1, f: ([a]) => (a === null ? null : str(a).toUpperCase()), py: ([a]) => `${a}.str.upper()` },
  trim: { min: 1, max: 1, f: ([a]) => (a === null ? null : str(a).trim()), py: ([a]) => `${a}.str.strip()` },
  len: { min: 1, max: 1, f: ([a]) => (a === null ? null : str(a).length), py: ([a]) => `${a}.str.len()` },
  contains: { min: 2, max: 2, f: ([a, b]) => (a === null ? false : str(a).toLowerCase().includes(str(b).toLowerCase())), py: ([a, b]) => `${a}.str.contains(${b}, case=False, regex=False)` },
  startswith: { min: 2, max: 2, f: ([a, b]) => (a === null ? false : str(a).startsWith(str(b))), py: ([a, b]) => `${a}.str.startswith(${b})` },
  endswith: { min: 2, max: 2, f: ([a, b]) => (a === null ? false : str(a).endsWith(str(b))), py: ([a, b]) => `${a}.str.endswith(${b})` },
  replace: { min: 3, max: 3, f: ([a, b, c]) => (a === null ? null : str(a).split(str(b)).join(str(c))), py: ([a, b, c]) => `${a}.str.replace(${b}, ${c}, regex=False)` },
  substr: { min: 2, max: 3, f: ([a, s, l]) => (a === null ? null : str(a).substr(Math.trunc(numArg(s)) || 0, l === undefined ? undefined : Math.max(0, Math.trunc(numArg(l)) || 0))), py: ([a, s, l]) => `${a}.str.slice(${s}${l === undefined ? '' : `, ${s} + ${l}`})` },
  isnull: { min: 1, max: 1, f: ([a]) => isNull(a), py: ([a]) => `${a}.isna()` },
  notnull: { min: 1, max: 1, f: ([a]) => !isNull(a), py: ([a]) => `${a}.notna()` },
  coalesce: { min: 2, max: 8, f: (xs) => xs.find((x) => !isNull(x)) ?? null, py: (xs) => xs.reduce((acc, x) => `${acc}.fillna(${x})`) },
  if: { min: 3, max: 3, f: ([c, a, b]) => (truthy(c) ? a : b), py: ([c, a, b]) => `np.where(${c}, ${a}, ${b})` },
  year: { min: 1, max: 1, f: ([a]) => date(a)?.getUTCFullYear() ?? null, py: ([a]) => `pd.to_datetime(${a}, errors="coerce").dt.year` },
  month: { min: 1, max: 1, f: ([a]) => { const d = date(a); return d ? d.getUTCMonth() + 1 : null; }, py: ([a]) => `pd.to_datetime(${a}, errors="coerce").dt.month` },
  day: { min: 1, max: 1, f: ([a]) => date(a)?.getUTCDate() ?? null, py: ([a]) => `pd.to_datetime(${a}, errors="coerce").dt.day` },
  weekday: { min: 1, max: 1, f: ([a]) => { const d = date(a); return d ? (d.getUTCDay() + 6) % 7 : null; }, py: ([a]) => `pd.to_datetime(${a}, errors="coerce").dt.weekday` },
  days_between: { min: 2, max: 2, f: ([a, b]) => { const x = date(a); const y = date(b); return x && y ? (y.getTime() - x.getTime()) / 86_400_000 : null; }, py: ([a, b]) => `(pd.to_datetime(${b}, errors="coerce") - pd.to_datetime(${a}, errors="coerce")).dt.days` },
};

function compare(a: Cell, b: Cell): number {
  const x = num(a);
  const y = num(b);
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x < y ? -1 : x > y ? 1 : 0;
  const sa = str(a);
  const sb = str(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function equals(a: Cell, b: Cell): boolean {
  if (a === null || b === null) return isNull(a) && isNull(b);
  const x = num(a);
  const y = num(b);
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x === y;
  if (typeof a === 'boolean' || typeof b === 'boolean') return truthy(a) === truthy(b);
  return str(a) === str(b);
}

export type RowGetter = (name: string) => Cell;

export function evaluate(n: Node, get: RowGetter): Cell {
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'col':
      return get(n.name);
    case 'un': {
      const a = evaluate(n.a, get);
      return n.op === '-' ? nOrNull(-num(a)) : !truthy(a);
    }
    case 'list':
      return null;
    case 'call':
      return FUNCTIONS[n.fn].f(n.args.map((a) => evaluate(a, get)));
    case 'bin': {
      if (n.op === 'and') return truthy(evaluate(n.a, get)) && truthy(evaluate(n.b, get));
      if (n.op === 'or') return truthy(evaluate(n.a, get)) || truthy(evaluate(n.b, get));
      const a = evaluate(n.a, get);
      if (n.op === 'in') return (n.b as Extract<Node, { k: 'list' }>).items.some((it) => equals(a, evaluate(it, get)));
      const b = evaluate(n.b, get);
      switch (n.op) {
        case '==':
          return equals(a, b);
        case '!=':
          return !equals(a, b);
        case '<':
          return a !== null && b !== null && compare(a, b) < 0;
        case '<=':
          return a !== null && b !== null && compare(a, b) <= 0;
        case '>':
          return a !== null && b !== null && compare(a, b) > 0;
        case '>=':
          return a !== null && b !== null && compare(a, b) >= 0;
        case '+': {
          const x = num(a);
          const y = num(b);
          if (Number.isNaN(x) || Number.isNaN(y)) return a === null || b === null ? null : str(a) + str(b);
          return nOrNull(x + y);
        }
        case '-':
          return nOrNull(num(a) - num(b));
        case '*':
          return nOrNull(num(a) * num(b));
        case '/':
          return nOrNull(num(a) / num(b));
        case '%':
          return nOrNull(num(a) % num(b));
        case '^':
          return nOrNull(Math.pow(num(a), num(b)));
      }
    }
  }
  return null;
}

/** Python string literal (double-quoted, escaped). */
export function pyStr(s: string): string {
  return JSON.stringify(s);
}

/** Translates an expression to a pandas expression over `df` (best effort, readable). */
export function toPandas(n: Node, df = 'df'): string {
  switch (n.k) {
    case 'lit':
      return n.v === null ? 'np.nan' : typeof n.v === 'string' ? pyStr(n.v) : typeof n.v === 'boolean' ? (n.v ? 'True' : 'False') : String(n.v);
    case 'col':
      return `${df}[${pyStr(n.name)}]`;
    case 'un':
      return n.op === '-' ? `(-${toPandas(n.a, df)})` : `(~${toPandas(n.a, df)})`;
    case 'list':
      return `[${n.items.map((i) => toPandas(i, df)).join(', ')}]`;
    case 'call':
      return FUNCTIONS[n.fn].py(n.args.map((a) => toPandas(a, df)));
    case 'bin': {
      const a = toPandas(n.a, df);
      const b = toPandas(n.b, df);
      const map: Record<string, string> = { and: '&', or: '|', '^': '**' };
      if (n.op === 'in') return `${a}.isin(${b})`;
      return `(${a} ${map[n.op] ?? n.op} ${b})`;
    }
  }
}
