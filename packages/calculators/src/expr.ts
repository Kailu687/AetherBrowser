/**
 * Safe engineering expression evaluator (no `eval`, no property access).
 *
 * Supports: + - * / ^ %, unary minus, parentheses, `||` for parallel
 * impedances (10k || 10k = 5k), SI suffixes on numbers (4.7k, 100n, 2.2u,
 * 1meg), scientific notation, constants, functions, and variables via
 * `name = expr` assignments that persist in a Scope.
 */

export type Scope = Map<string, number>;

export class ExprError extends Error {
  constructor(message: string, readonly position: number) {
    super(message);
    this.name = "ExprError";
  }
}

const SUFFIX: Record<string, number> = {
  T: 1e12, G: 1e9, M: 1e6, meg: 1e6, k: 1e3, K: 1e3, m: 1e-3, u: 1e-6, "µ": 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
};

export const CONSTANTS: Record<string, { value: number; description: string }> = {
  pi: { value: Math.PI, description: "π" },
  tau: { value: 2 * Math.PI, description: "2π" },
  e: { value: Math.E, description: "Euler's number" },
  c: { value: 299_792_458, description: "Speed of light, m/s" },
  q: { value: 1.602_176_634e-19, description: "Elementary charge, C" },
  kB: { value: 1.380_649e-23, description: "Boltzmann constant, J/K" },
  h: { value: 6.626_070_15e-34, description: "Planck constant, J·s" },
  eps0: { value: 8.854_187_8128e-12, description: "Vacuum permittivity, F/m" },
  mu0: { value: 1.256_637_062_12e-6, description: "Vacuum permeability, H/m" },
  g0: { value: 9.806_65, description: "Standard gravity, m/s²" },
  NA: { value: 6.022_140_76e23, description: "Avogadro constant, 1/mol" },
  R: { value: 8.314_462_618, description: "Gas constant, J/(mol·K)" },
  G: { value: 6.674_30e-11, description: "Gravitational constant, m³/(kg·s²)" },
  VT: { value: (1.380_649e-23 * 300) / 1.602_176_634e-19, description: "Thermal voltage at 300 K, V" },
};

type Fn = (...args: number[]) => number;
const deg = (x: number) => (x * 180) / Math.PI;
const rad = (x: number) => (x * Math.PI) / 180;
export const FUNCTIONS: Record<string, { fn: Fn; arity: number | [number, number] }> = {
  sin: { fn: Math.sin, arity: 1 }, cos: { fn: Math.cos, arity: 1 }, tan: { fn: Math.tan, arity: 1 },
  asin: { fn: Math.asin, arity: 1 }, acos: { fn: Math.acos, arity: 1 }, atan: { fn: Math.atan, arity: 1 },
  atan2: { fn: Math.atan2, arity: 2 },
  sind: { fn: (x) => Math.sin(rad(x)), arity: 1 }, cosd: { fn: (x) => Math.cos(rad(x)), arity: 1 }, tand: { fn: (x) => Math.tan(rad(x)), arity: 1 },
  sinh: { fn: Math.sinh, arity: 1 }, cosh: { fn: Math.cosh, arity: 1 }, tanh: { fn: Math.tanh, arity: 1 },
  sqrt: { fn: Math.sqrt, arity: 1 }, cbrt: { fn: Math.cbrt, arity: 1 }, abs: { fn: Math.abs, arity: 1 },
  exp: { fn: Math.exp, arity: 1 }, ln: { fn: Math.log, arity: 1 }, log: { fn: Math.log10, arity: [1, 2] },
  log10: { fn: Math.log10, arity: 1 }, log2: { fn: Math.log2, arity: 1 },
  floor: { fn: Math.floor, arity: 1 }, ceil: { fn: Math.ceil, arity: 1 }, round: { fn: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d, arity: [1, 2] },
  min: { fn: Math.min, arity: [1, Infinity] }, max: { fn: Math.max, arity: [1, Infinity] }, hypot: { fn: Math.hypot, arity: [1, Infinity] },
  deg: { fn: deg, arity: 1 }, rad: { fn: rad, arity: 1 },
  par: { fn: (...r) => 1 / r.reduce((s, x) => s + 1 / x, 0), arity: [2, Infinity] },
  db: { fn: (x) => 20 * Math.log10(x), arity: 1 }, dbp: { fn: (x) => 10 * Math.log10(x), arity: 1 },
  undb: { fn: (x) => 10 ** (x / 20), arity: 1 },
  fact: { fn: factorial, arity: 1 },
  nCr: { fn: (n, r) => factorial(n) / (factorial(r) * factorial(n - r)), arity: 2 },
};
FUNCTIONS["log"]!.fn = (x, base?: number) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base));

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) return NaN;
  if (n > 170) return Infinity;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

type Tok =
  | { t: "num"; v: number; pos: number }
  | { t: "id"; v: string; pos: number }
  | { t: "op"; v: string; pos: number }
  | { t: "end"; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      let v = parseFloat(num[0]);
      const pos = i;
      i += num[0].length;
      // SI suffix only when it is not the start of a longer identifier (e.g. "2m" ok, "2max" no).
      const rest = src.slice(i);
      const suf = /^(meg|[TGMkKmunµpf])(?![A-Za-z_\d])/.exec(rest);
      if (suf) {
        v *= SUFFIX[suf[1]!]!;
        i += suf[1]!.length;
      }
      out.push({ t: "num", v, pos });
      continue;
    }
    const id = /^[A-Za-z_µ][A-Za-z_\d]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0], pos: i });
      i += id[0].length;
      continue;
    }
    if (src.startsWith("||", i) || src.startsWith("**", i)) {
      out.push({ t: "op", v: src.slice(i, i + 2) === "**" ? "^" : "||", pos: i });
      i += 2;
      continue;
    }
    if ("+-*/^%(),=×÷".includes(c)) {
      out.push({ t: "op", v: c === "×" ? "*" : c === "÷" ? "/" : c, pos: i });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected character "${c}"`, i);
  }
  out.push({ t: "end", pos: src.length });
  return out;
}

/** Evaluate an expression. Assignments ("x = 3k") store into `scope` and return the value. */
export function evaluate(src: string, scope: Scope = new Map()): number {
  const toks = tokenize(src);
  let k = 0;
  const peek = () => toks[k]!;
  const next = () => toks[k++]!;
  const isOp = (v: string) => {
    const t = peek();
    return t.t === "op" && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`Expected "${v}"`, peek().pos);
    next();
  };

  // Precedence: || (lowest) < + - < * / % < unary - < ^ (right assoc)
  const parallel = (): number => {
    let v = additive();
    while (isOp("||")) {
      next();
      const r = additive();
      v = (v * r) / (v + r);
    }
    return v;
  };
  const additive = (): number => {
    let v = multiplicative();
    for (;;) {
      if (isOp("+")) {
        next();
        v += multiplicative();
      } else if (isOp("-")) {
        next();
        v -= multiplicative();
      } else return v;
    }
  };
  const multiplicative = (): number => {
    let v = unary();
    for (;;) {
      if (isOp("*")) {
        next();
        v *= unary();
      } else if (isOp("/")) {
        next();
        v /= unary();
      } else if (isOp("%")) {
        next();
        v %= unary();
      } else return v;
    }
  };
  const unary = (): number => {
    if (isOp("-")) {
      next();
      return -unary();
    }
    if (isOp("+")) {
      next();
      return unary();
    }
    return power();
  };
  const power = (): number => {
    const base = primary();
    if (isOp("^")) {
      next();
      return base ** unary();
    }
    return base;
  };
  const primary = (): number => {
    const t = next();
    if (t.t === "num") return t.v;
    if (t.t === "op" && t.v === "(") {
      const v = parallel();
      expect(")");
      return v;
    }
    if (t.t === "id") {
      if (isOp("(")) {
        const f = Object.hasOwn(FUNCTIONS, t.v) ? FUNCTIONS[t.v] : undefined;
        if (!f) throw new ExprError(`Unknown function "${t.v}"`, t.pos);
        next();
        const args: number[] = [];
        if (!isOp(")")) {
          args.push(parallel());
          while (isOp(",")) {
            next();
            args.push(parallel());
          }
        }
        expect(")");
        const [lo, hi] = Array.isArray(f.arity) ? f.arity : [f.arity, f.arity];
        if (args.length < lo || args.length > hi) throw new ExprError(`${t.v}() takes ${lo === hi ? lo : `${lo}+`} argument${lo === 1 && hi === 1 ? "" : "s"}`, t.pos);
        return f.fn(...args);
      }
      if (scope.has(t.v)) return scope.get(t.v)!;
      const c = Object.hasOwn(CONSTANTS, t.v) ? CONSTANTS[t.v] : undefined;
      if (c) return c.value;
      throw new ExprError(`Unknown name "${t.v}"`, t.pos);
    }
    throw new ExprError(t.t === "end" ? "Unexpected end of expression" : `Unexpected "${(t as { v: string }).v}"`, t.pos);
  };

  // Assignment: identifier '=' expr
  let target: string | undefined;
  if (toks[0]?.t === "id" && toks[1]?.t === "op" && toks[1].v === "=") {
    target = toks[0].v;
    if (Object.hasOwn(FUNCTIONS, target)) throw new ExprError(`"${target}" is a function name`, 0);
    k = 2;
  }
  const value = parallel();
  if (peek().t !== "end") throw new ExprError(`Unexpected "${(peek() as { v?: string }).v ?? ""}"`, peek().pos);
  if (target) scope.set(target, value);
  scope.set("ans", value);
  return value;
}

export interface ScratchLine {
  input: string;
  value?: number;
  error?: string;
}

/** Evaluate a multi-line scratchpad (like a calculator notebook); each line sees earlier variables. */
export function evaluateLines(lines: string[], scope: Scope = new Map()): ScratchLine[] {
  return lines.map((input) => {
    const src = input.replace(/#.*$/, "").trim();
    if (!src) return { input };
    try {
      return { input, value: evaluate(src, scope) };
    } catch (e) {
      return { input, error: (e as Error).message };
    }
  });
}
