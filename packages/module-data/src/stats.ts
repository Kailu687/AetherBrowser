import { type Cell, type Table, getColumn, isMissing, num } from './table.js';

export function numericValues(values: Cell[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    const n = num(v);
    if (!Number.isNaN(n)) out.push(n);
  }
  return out;
}

export function mean(xs: ArrayLike<number>): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s / xs.length;
}

/** Sample standard deviation (n − 1), Welford's algorithm. */
export function std(xs: ArrayLike<number>): number {
  if (xs.length < 2) return NaN;
  let m = 0;
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    const d = xs[i] - m;
    m += d / (i + 1);
    s += d * (xs[i] - m);
  }
  return Math.sqrt(s / (xs.length - 1));
}

/** Linear-interpolated quantile of an ascending-sorted array (type 7, the NumPy/pandas default). */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const pos = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function sortedCopy(xs: number[]): Float64Array {
  return Float64Array.from(xs).sort();
}

export function skewness(xs: ArrayLike<number>): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const m = mean(xs);
  let m2 = 0;
  let m3 = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  if (m2 === 0) return 0;
  // Adjusted Fisher–Pearson (pandas .skew()).
  return (Math.sqrt(n * (n - 1)) / (n - 2)) * (m3 / Math.pow(m2, 1.5));
}

export function pearson(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return NaN;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy);
}

/** Average ranks (ties share the mean rank). */
export function ranks(xs: ArrayLike<number>): Float64Array {
  const idx = Array.from({ length: xs.length }, (_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const r = new Float64Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]] === xs[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}

export function spearman(x: ArrayLike<number>, y: ArrayLike<number>): number {
  return pearson(ranks(x), ranks(y));
}

/** Pairs of numeric values where both are present. */
export function pairedNumeric(a: Cell[], b: Cell[]): [number[], number[]] {
  const xs: number[] = [];
  const ys: number[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = num(a[i]);
    const y = num(b[i]);
    if (!Number.isNaN(x) && !Number.isNaN(y)) {
      xs.push(x);
      ys.push(y);
    }
  }
  return [xs, ys];
}

export interface CorrelationMatrix {
  columns: string[];
  method: 'pearson' | 'spearman';
  values: number[][];
  /** Pairwise sample sizes. */
  n: number[][];
}

export function correlationMatrix(t: Table, columns: string[], method: 'pearson' | 'spearman' = 'pearson'): CorrelationMatrix {
  const cols = columns.map((c) => getColumn(t, c).values);
  const k = cols.length;
  const values = Array.from({ length: k }, () => new Array<number>(k).fill(NaN));
  const n = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      const [x, y] = pairedNumeric(cols[i], cols[j]);
      const r = i === j ? (x.length > 1 ? 1 : NaN) : method === 'pearson' ? pearson(x, y) : spearman(x, y);
      values[i][j] = values[j][i] = r;
      n[i][j] = n[j][i] = x.length;
    }
  }
  return { columns, method, values, n };
}

export interface ValueCount {
  value: string;
  count: number;
}

export function valueCounts(values: Cell[], limit = 20): { top: ValueCount[]; distinct: number; missing: number } {
  const m = new Map<string, number>();
  let missing = 0;
  for (const v of values) {
    if (isMissing(v)) {
      missing++;
      continue;
    }
    const k = String(v);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const top = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, limit).map(([value, count]) => ({ value, count }));
  return { top, distinct: m.size, missing };
}

export interface Histogram {
  edges: number[];
  counts: number[];
}

/** Equal-width histogram; bin count from the Freedman–Diaconis rule, clamped to [5, 60]. */
export function histogram(xs: number[], bins?: number): Histogram {
  if (xs.length === 0) return { edges: [], counts: [] };
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of xs) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  if (lo === hi) return { edges: [lo, hi], counts: [xs.length] };
  let k = bins;
  if (!k) {
    const s = sortedCopy(xs);
    const iqr = quantileSorted(s, 0.75) - quantileSorted(s, 0.25);
    const w = iqr > 0 ? (2 * iqr) / Math.cbrt(xs.length) : (hi - lo) / Math.ceil(Math.log2(xs.length) + 1);
    k = Math.ceil((hi - lo) / w);
  }
  k = Math.max(5, Math.min(60, Math.round(k)));
  const width = (hi - lo) / k;
  const counts = new Array<number>(k).fill(0);
  for (const x of xs) counts[Math.min(k - 1, Math.floor((x - lo) / width))]++;
  const edges = Array.from({ length: k + 1 }, (_, i) => lo + i * width);
  return { edges, counts };
}

export interface NumericSummary {
  count: number;
  mean: number;
  std: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  skew: number;
  zeros: number;
  negatives: number;
  /** Values outside [q1 − 1.5·IQR, q3 + 1.5·IQR]. */
  outliers: number;
}

export function numericSummary(xs: number[]): NumericSummary {
  const s = sortedCopy(xs);
  const q1 = quantileSorted(s, 0.25);
  const q3 = quantileSorted(s, 0.75);
  const iqr = q3 - q1;
  let outliers = 0;
  let zeros = 0;
  let negatives = 0;
  for (const x of xs) {
    if (x < q1 - 1.5 * iqr || x > q3 + 1.5 * iqr) outliers++;
    if (x === 0) zeros++;
    if (x < 0) negatives++;
  }
  return { count: xs.length, mean: mean(xs), std: std(xs), min: s[0] ?? NaN, q1, median: quantileSorted(s, 0.5), q3, max: s[s.length - 1] ?? NaN, skew: skewness(xs), zeros, negatives, outliers };
}

/** Welch's two-sample t statistic and approximate two-sided p-value (normal approximation for df > 30, else Student t via series). */
export function welchT(a: number[], b: number[]): { t: number; df: number; p: number } {
  const ma = mean(a);
  const mb = mean(b);
  const va = std(a) ** 2;
  const vb = std(b) ** 2;
  const se = Math.sqrt(va / a.length + vb / b.length);
  const t = (ma - mb) / se;
  const df = (va / a.length + vb / b.length) ** 2 / ((va / a.length) ** 2 / (a.length - 1) + (vb / b.length) ** 2 / (b.length - 1));
  return { t, df, p: studentTwoSidedP(t, df) };
}

/** Two-sided p-value for Student's t via the regularised incomplete beta function. */
export function studentTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return NaN;
  const x = df / (df + t * t);
  return incompleteBeta(x, df / 2, 0.5);
}

function logGamma(z: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularised incomplete beta I_x(a, b) by continued fraction (Numerical Recipes betacf). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(x, a, b)) / a;
  return 1 - (bt * betacf(1 - x, b, a)) / b;
}

function betacf(x: number, a: number, b: number): number {
  const EPS = 1e-12;
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
