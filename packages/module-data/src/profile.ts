import { type Table, isMissing, num, rowCount } from './table.js';
import { type ColumnSchema, type ColumnType, dateValue, inferColumn, isNumericType } from './schema.js';
import { type Histogram, type NumericSummary, type ValueCount, histogram, numericSummary, numericValues, valueCounts } from './stats.js';
import { type PiiFinding, scanColumn } from './pii.js';

export type WarningLevel = 'info' | 'warn' | 'risk';

export interface ProfileWarning {
  level: WarningLevel;
  column?: string;
  code: string;
  message: string;
}

export interface ColumnProfile {
  name: string;
  schema: ColumnSchema;
  count: number;
  missing: number;
  missingPct: number;
  distinct: number;
  /** Distinct count is a lower bound when the column has more than this many values. */
  distinctCapped: boolean;
  top: ValueCount[];
  numeric?: NumericSummary;
  histogram?: Histogram;
  text?: { minLength: number; maxLength: number; meanLength: number; leadingTrailingSpace: number };
  dates?: { min: string; max: string };
  pii: PiiFinding[];
}

export interface DatasetProfile {
  rows: number;
  columns: number;
  duplicateRows: number;
  missingCells: number;
  approxBytes: number;
  profiles: ColumnProfile[];
  warnings: ProfileWarning[];
}

function looksLikeId(name: string, type: ColumnType, distinct: number, count: number): boolean {
  if (count < 20) return false;
  const unique = distinct === count;
  return unique && (/(^|_|\b)(id|uuid|guid|key|index|row(_?num)?|serial)$/i.test(name) || type === 'integer' || type === 'text');
}

export function profileColumn(name: string, values: Table['columns'][number]['values']): ColumnProfile {
  const schema = inferColumn(name, values);
  const vc = valueCounts(values, 10);
  const count = values.length;
  const p: ColumnProfile = {
    name,
    schema,
    count,
    missing: vc.missing,
    missingPct: count ? vc.missing / count : 0,
    distinct: vc.distinct,
    distinctCapped: false,
    top: vc.top,
    pii: [],
  };
  if (isNumericType(schema.type) || schema.type === 'boolean') {
    const xs = numericValues(values);
    if (xs.length) {
      p.numeric = numericSummary(xs);
      if (isNumericType(schema.type)) p.histogram = histogram(xs);
    }
  }
  if (schema.type === 'text' || schema.type === 'categorical') {
    let minL = Infinity;
    let maxL = 0;
    let sum = 0;
    let n = 0;
    let spaces = 0;
    for (const v of values) {
      if (isMissing(v)) continue;
      const s = String(v);
      minL = Math.min(minL, s.length);
      maxL = Math.max(maxL, s.length);
      sum += s.length;
      n++;
      if (s !== s.trim()) spaces++;
    }
    if (n) p.text = { minLength: minL, maxLength: maxL, meanLength: sum / n, leadingTrailingSpace: spaces };
    p.pii = scanColumn(name, values);
  }
  if (schema.type === 'date' || schema.type === 'datetime') {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      const d = dateValue(v);
      if (!Number.isNaN(d)) {
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
    }
    if (Number.isFinite(lo)) p.dates = { min: new Date(lo).toISOString(), max: new Date(hi).toISOString() };
  }
  if (schema.type === 'integer') p.pii = scanColumn(name, values).filter((f) => f.kind === 'phone' || f.kind === 'aadhaar' || f.kind === 'card' || f.count === 0);
  return p;
}

/** Hash of a row, used to count exact duplicates without holding row strings. */
function rowKey(t: Table, i: number): string {
  let s = '';
  for (const c of t.columns) {
    const v = c.values[i];
    s += (v === null ? '\u0000' : typeof v + ':' + String(v)) + '\u0001';
  }
  return s;
}

export function countDuplicateRows(t: Table): number {
  const n = rowCount(t);
  const seen = new Set<string>();
  let dup = 0;
  for (let i = 0; i < n; i++) {
    const k = rowKey(t, i);
    if (seen.has(k)) dup++;
    else seen.add(k);
  }
  return dup;
}

export function profileTable(t: Table): DatasetProfile {
  const rows = rowCount(t);
  const profiles = t.columns.map((c) => profileColumn(c.name, c.values));
  const warnings: ProfileWarning[] = [];
  let missingCells = 0;
  let bytes = 0;
  for (const c of t.columns) {
    for (const v of c.values) bytes += v === null ? 1 : typeof v === 'string' ? v.length * 2 + 8 : 8;
  }
  for (const p of profiles) {
    missingCells += p.missing;
    const col = p.name;
    if (p.schema.type === 'empty') warnings.push({ level: 'warn', column: col, code: 'empty', message: `“${col}” has no values.` });
    else if (p.distinct === 1 && rows > 1) warnings.push({ level: 'info', column: col, code: 'constant', message: `“${col}” has the same value in every row; it carries no information for a model.` });
    if (p.missingPct >= 0.5 && p.schema.type !== 'empty') warnings.push({ level: 'warn', column: col, code: 'missing', message: `“${col}” is ${(p.missingPct * 100).toFixed(0)}% missing.` });
    else if (p.missingPct > 0.05) warnings.push({ level: 'info', column: col, code: 'missing', message: `“${col}” is ${(p.missingPct * 100).toFixed(1)}% missing.` });
    if (p.schema.confidence < 1 && p.schema.mismatches.length && (isNumericType(p.schema.type) || p.schema.type === 'date' || p.schema.type === 'datetime')) {
      warnings.push({ level: 'warn', column: col, code: 'mixed', message: `“${col}” is mostly ${p.schema.type} but has other values, e.g. ${p.schema.mismatches.slice(0, 3).map((m) => JSON.stringify(m)).join(', ')}.` });
    }
    if (looksLikeId(col, p.schema.type, p.distinct, p.count - p.missing)) warnings.push({ level: 'info', column: col, code: 'id', message: `“${col}” is unique per row and looks like an identifier. Exclude it from model features.` });
    if (p.schema.type === 'categorical' && p.distinct > 100) warnings.push({ level: 'info', column: col, code: 'cardinality', message: `“${col}” has ${p.distinct} categories; one-hot encoding would add that many columns.` });
    if (p.numeric && p.numeric.count > 20 && Math.abs(p.numeric.skew) > 2) warnings.push({ level: 'info', column: col, code: 'skew', message: `“${col}” is strongly skewed (skew ${p.numeric.skew.toFixed(1)}); consider a log transform.` });
    if (p.numeric && p.numeric.outliers > 0 && p.numeric.outliers / p.numeric.count > 0.05) warnings.push({ level: 'info', column: col, code: 'outliers', message: `“${col}” has ${p.numeric.outliers} values outside 1.5×IQR.` });
    if (p.text && p.text.leadingTrailingSpace > 0) warnings.push({ level: 'info', column: col, code: 'whitespace', message: `${p.text.leadingTrailingSpace} values in “${col}” have leading or trailing spaces (try a Trim step).` });
    for (const f of p.pii) warnings.push({ level: 'risk', column: col, code: `pii-${f.kind}`, message: `“${col}” may contain ${f.kind === 'password-field' ? 'secrets' : f.kind} data (${f.sample}). Check before sharing or sending to a cloud model.` });
  }
  const duplicateRows = countDuplicateRows(t);
  if (duplicateRows > 0) warnings.push({ level: 'warn', code: 'duplicates', message: `${duplicateRows} rows are exact duplicates of an earlier row.` });
  return { rows, columns: t.columns.length, duplicateRows, missingCells, approxBytes: bytes, profiles, warnings };
}

/** Numeric value or NaN; re-exported for callers that work on profiled columns. */
export { num };
