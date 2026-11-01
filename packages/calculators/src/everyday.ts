/** Everyday and programming helpers. */

export type Base = 2 | 8 | 10 | 16;

/** Convert an integer string between bases; supports 0x/0b/0o prefixes, underscores, and BigInt-sized values. */
export function convertBase(input: string, from: Base | "auto" = "auto"): { bin: string; oct: string; dec: string; hex: string; value: bigint } {
  let s = input.trim().replace(/_/g, "").toLowerCase();
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  let base: Base = from === "auto" ? 10 : from;
  if (from === "auto") {
    if (s.startsWith("0x")) (base = 16), (s = s.slice(2));
    else if (s.startsWith("0b")) (base = 2), (s = s.slice(2));
    else if (s.startsWith("0o")) (base = 8), (s = s.slice(2));
  }
  const digits = "0123456789abcdef".slice(0, base);
  if (!s || ![...s].every((c) => digits.includes(c))) throw new RangeError(`"${input}" is not a valid base-${base} integer`);
  let v = 0n;
  for (const c of s) v = v * BigInt(base) + BigInt(digits.indexOf(c));
  if (neg) v = -v;
  const fmt = (b: number) => (v < 0n ? "-" : "") + (v < 0n ? -v : v).toString(b);
  return { bin: fmt(2), oct: fmt(8), dec: fmt(10), hex: fmt(16), value: v };
}

/** Two's complement representation of a signed value in `bits` bits. */
export function twosComplement(value: number | bigint, bits = 8): string {
  const v = BigInt(value);
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (v < min || v > max) throw new RangeError(`${value} does not fit in ${bits} signed bits`);
  const u = v < 0n ? (1n << BigInt(bits)) + v : v;
  return u.toString(2).padStart(bits, "0");
}

export const percent = {
  of: (p: number, x: number) => (p / 100) * x,
  change: (from: number, to: number) => ((to - from) / Math.abs(from)) * 100,
  whatPercent: (part: number, whole: number) => (part / whole) * 100,
};

/** Equated monthly instalment for a loan. Rate is annual percent. */
export function loanEmi(principal: number, annualRatePct: number, months: number) {
  const r = annualRatePct / 12 / 100;
  const emi = r === 0 ? principal / months : (principal * r * (1 + r) ** months) / ((1 + r) ** months - 1);
  return { emi, total: emi * months, interest: emi * months - principal };
}

/** Compound growth with periodic compounding (n per year). */
export const compound = (principal: number, annualRatePct: number, years: number, n = 12) => principal * (1 + annualRatePct / 100 / n) ** (n * years);

/** Weighted grade point average. */
export function gpa(courses: Array<{ credits: number; grade: number }>): number {
  const credits = courses.reduce((s, c) => s + c.credits, 0);
  return credits ? courses.reduce((s, c) => s + c.credits * c.grade, 0) / credits : 0;
}

/** Statistics for a list of numbers (sample standard deviation). */
export function stats(xs: number[]) {
  if (!xs.length) throw new RangeError("Need at least one value");
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sorted = [...xs].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  const variance = n > 1 ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
  return { n, mean, median, min: sorted[0]!, max: sorted[n - 1]!, stdev: Math.sqrt(variance), sum: mean * n };
}

/** Least-squares line fit y = m·x + b, with R². */
export function linearFit(points: Array<[number, number]>) {
  const n = points.length;
  if (n < 2) throw new RangeError("Need at least two points");
  const sx = points.reduce((s, [x]) => s + x, 0);
  const sy = points.reduce((s, [, y]) => s + y, 0);
  const sxx = points.reduce((s, [x]) => s + x * x, 0);
  const sxy = points.reduce((s, [x, y]) => s + x * y, 0);
  const m = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const b = (sy - m * sx) / n;
  const meanY = sy / n;
  const ssTot = points.reduce((s, [, y]) => s + (y - meanY) ** 2, 0);
  const ssRes = points.reduce((s, [x, y]) => s + (y - (m * x + b)) ** 2, 0);
  return { slope: m, intercept: b, r2: ssTot ? 1 - ssRes / ssTot : 1 };
}
