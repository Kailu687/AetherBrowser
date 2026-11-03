/**
 * Dataset comparison: schema changes, row-level differences by key, and
 * distribution drift per shared column (mean shift for numbers, population
 * stability index for both numbers and categories).
 */
import { type Cell, type Table, DataError, getColumn, isMissing, rowCount } from './table.js';
import { inferSchema, isNumericType, type ColumnType } from './schema.js';
import { mean, numericValues, quantileSorted, sortedCopy, std } from './stats.js';

export interface SchemaChange {
  column: string;
  change: 'added' | 'removed' | 'type';
  from?: ColumnType;
  to?: ColumnType;
}

export interface ColumnDrift {
  column: string;
  kind: 'numeric' | 'categorical';
  missingA: number;
  missingB: number;
  meanA?: number;
  meanB?: number;
  /** (meanB − meanA) / pooled std. */
  standardizedShift?: number;
  /** Population stability index; < 0.1 stable, 0.1–0.25 moderate, > 0.25 large shift (a common rule of thumb). */
  psi: number;
  level: 'stable' | 'moderate' | 'large';
}

export interface RowDiff {
  key: string[];
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  duplicateKeysA: number;
  duplicateKeysB: number;
  /** Up to 50 examples of changed rows. */
  examples: { key: string; column: string; a: Cell; b: Cell }[];
}

export interface DatasetComparison {
  rowsA: number;
  rowsB: number;
  schema: SchemaChange[];
  drift: ColumnDrift[];
  rows?: RowDiff;
}

const EPS = 1e-4;

function psi(pa: number[], pb: number[]): number {
  let s = 0;
  for (let i = 0; i < pa.length; i++) {
    const a = Math.max(pa[i], EPS);
    const b = Math.max(pb[i], EPS);
    s += (b - a) * Math.log(b / a);
  }
  return s;
}

const level = (p: number): ColumnDrift['level'] => (p < 0.1 ? 'stable' : p < 0.25 ? 'moderate' : 'large');

export function numericDrift(column: string, a: Cell[], b: Cell[]): ColumnDrift {
  const xa = numericValues(a);
  const xb = numericValues(b);
  const sa = sortedCopy(xa);
  // Decile bins from A.
  const edges = Array.from({ length: 9 }, (_, i) => quantileSorted(sa, (i + 1) / 10));
  const bin = (x: number) => { let k = 0; while (k < edges.length && x > edges[k]) k++; return k; };
  const ca = new Array(10).fill(0);
  const cb = new Array(10).fill(0);
  xa.forEach((x) => ca[bin(x)]++);
  xb.forEach((x) => cb[bin(x)]++);
  const p = psi(ca.map((c) => c / (xa.length || 1)), cb.map((c) => c / (xb.length || 1)));
  const ma = mean(xa);
  const mb = mean(xb);
  const pooled = Math.sqrt(((std(xa) || 0) ** 2 + (std(xb) || 0) ** 2) / 2);
  return { column, kind: 'numeric', missingA: a.length - xa.length, missingB: b.length - xb.length, meanA: ma, meanB: mb, standardizedShift: pooled > 0 ? (mb - ma) / pooled : 0, psi: p, level: level(p) };
}

export function categoricalDrift(column: string, a: Cell[], b: Cell[]): ColumnDrift {
  const count = (vs: Cell[]) => { const m = new Map<string, number>(); let miss = 0; for (const v of vs) { if (isMissing(v)) { miss++; continue; } m.set(String(v), (m.get(String(v)) ?? 0) + 1); } return { m, miss }; };
  const A = count(a);
  const B = count(b);
  const keys = [...new Set([...A.m.keys(), ...B.m.keys()])];
  const na = a.length - A.miss || 1;
  const nb = b.length - B.miss || 1;
  const p = psi(keys.map((k) => (A.m.get(k) ?? 0) / na), keys.map((k) => (B.m.get(k) ?? 0) / nb));
  return { column, kind: 'categorical', missingA: A.miss, missingB: B.miss, psi: p, level: level(p) };
}

function cellEq(a: Cell, b: Cell): boolean {
  if (isMissing(a) && isMissing(b)) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  return String(a) === String(b);
}

export function compareTables(a: Table, b: Table, opts: { key?: string[] } = {}): DatasetComparison {
  const sa = inferSchema(a);
  const sb = inferSchema(b);
  const typeA = new Map(sa.columns.map((c) => [c.name, c.type]));
  const typeB = new Map(sb.columns.map((c) => [c.name, c.type]));
  const schema: SchemaChange[] = [];
  for (const [n, t] of typeA) {
    if (!typeB.has(n)) schema.push({ column: n, change: 'removed', from: t });
    else if (typeB.get(n) !== t) schema.push({ column: n, change: 'type', from: t, to: typeB.get(n) });
  }
  for (const [n, t] of typeB) if (!typeA.has(n)) schema.push({ column: n, change: 'added', to: t });
  const drift: ColumnDrift[] = [];
  for (const [n, t] of typeA) {
    if (!typeB.has(n)) continue;
    const va = getColumn(a, n).values;
    const vb = getColumn(b, n).values;
    if (isNumericType(t) && isNumericType(typeB.get(n)!)) drift.push(numericDrift(n, va, vb));
    else if (t === 'categorical' || t === 'boolean') drift.push(categoricalDrift(n, va, vb));
  }
  const out: DatasetComparison = { rowsA: rowCount(a), rowsB: rowCount(b), schema, drift };
  if (opts.key?.length) out.rows = diffRows(a, b, opts.key);
  return out;
}

export function diffRows(a: Table, b: Table, key: string[]): RowDiff {
  const ka = key.map((k) => getColumn(a, k).values);
  const kb = key.map((k) => getColumn(b, k).values);
  const keyAt = (vs: Cell[][], i: number) => JSON.stringify(vs.map((v) => v[i]));
  const index = (vs: Cell[][], n: number) => { const m = new Map<string, number>(); let dup = 0; for (let i = 0; i < n; i++) { const k = keyAt(vs, i); if (m.has(k)) dup++; else m.set(k, i); } return { m, dup }; };
  const A = index(ka, rowCount(a));
  const B = index(kb, rowCount(b));
  if (A.m.size === 0 && rowCount(a) > 0) throw new DataError('compare', 'Key columns are empty.');
  const shared = a.columns.map((c) => c.name).filter((n) => !key.includes(n) && b.columns.some((x) => x.name === n));
  const ca = shared.map((n) => getColumn(a, n).values);
  const cb = shared.map((n) => getColumn(b, n).values);
  let changed = 0;
  let unchanged = 0;
  let removed = 0;
  const examples: RowDiff['examples'] = [];
  for (const [k, i] of A.m) {
    const j = B.m.get(k);
    if (j === undefined) { removed++; continue; }
    let diff = false;
    for (let c = 0; c < shared.length; c++) {
      if (!cellEq(ca[c][i], cb[c][j])) {
        diff = true;
        if (examples.length < 50) examples.push({ key: k, column: shared[c], a: ca[c][i], b: cb[c][j] });
      }
    }
    if (diff) changed++; else unchanged++;
  }
  let added = 0;
  for (const k of B.m.keys()) if (!A.m.has(k)) added++;
  return { key, added, removed, changed, unchanged, duplicateKeysA: A.dup, duplicateKeysB: B.dup, examples };
}
