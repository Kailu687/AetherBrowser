import { type Cell, type Table, isMissing, num, rowCount } from './table.js';

export type ColumnType = 'integer' | 'float' | 'boolean' | 'date' | 'datetime' | 'categorical' | 'text' | 'empty';

export interface ColumnSchema {
  name: string;
  type: ColumnType;
  nullable: boolean;
  /** Share of non-missing values that matched the inferred type (0–1). */
  confidence: number;
  /** Examples of values that did not match (at most 5). */
  mismatches: string[];
}

export interface Schema {
  columns: ColumnSchema[];
  rows: number;
}

const TRUE = new Set(['true', 'yes', 'y', 't', '1']);
const FALSE = new Set(['false', 'no', 'n', 'f', '0']);
const BOOL_WORDS = new Set(['true', 'false', 'yes', 'no', 'y', 'n', 't', 'f']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/;
const DMY_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

export function parseBool(v: Cell): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return TRUE.has(s) ? true : FALSE.has(s) ? false : null;
}

function isValidDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** ISO dates/datetimes only (plus dd/mm/yyyy, which is reported as a date with a mismatch note when ambiguous). */
export function classifyDate(s: string): 'date' | 'datetime' | null {
  const t = s.trim();
  if (DATE_RE.test(t)) {
    const [y, m, d] = t.split('-').map(Number);
    return isValidDate(y, m, d) ? 'date' : null;
  }
  if (DATETIME_RE.test(t)) return Number.isNaN(Date.parse(t.replace(' ', 'T'))) ? null : 'datetime';
  const m = DMY_RE.exec(t);
  if (m) return isValidDate(Number(m[3]), Number(m[2]), Number(m[1])) ? 'date' : null;
  return null;
}

/** Milliseconds since epoch for date-like cells, else NaN. dd/mm/yyyy is read day-first. */
export function dateValue(v: Cell): number {
  if (typeof v !== 'string') return NaN;
  const t = v.trim();
  const m = DMY_RE.exec(t);
  if (m) return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  if (DATE_RE.test(t)) return Date.parse(t + 'T00:00:00Z');
  if (DATETIME_RE.test(t)) return Date.parse(t.replace(' ', 'T'));
  return NaN;
}

export function inferColumn(name: string, values: Cell[], sampleLimit = 50_000): ColumnSchema {
  const step = values.length > sampleLimit ? values.length / sampleLimit : 1;
  let present = 0;
  let missing = 0;
  let ints = 0;
  let floats = 0;
  let bools = 0;
  let boolWords = 0;
  let dates = 0;
  let datetimes = 0;
  const distinct = new Set<string>();
  const notNumeric: string[] = [];
  let maxLen = 0;
  for (let k = 0; k < values.length; k += step) {
    const v = values[Math.floor(k)];
    if (isMissing(v)) {
      missing++;
      continue;
    }
    present++;
    if (distinct.size <= 1000) distinct.add(String(v));
    if (typeof v === 'boolean') {
      bools++;
      boolWords++;
      continue;
    }
    const n = num(v);
    if (!Number.isNaN(n)) {
      if (Number.isInteger(n) && !(typeof v === 'string' && /[.eE]/.test(v))) ints++;
      else floats++;
      if (n === 0 || n === 1) bools++;
      continue;
    }
    const s = String(v);
    maxLen = Math.max(maxLen, s.length);
    if (parseBool(s) !== null) {
      bools++;
      if (BOOL_WORDS.has(s.trim().toLowerCase())) boolWords++;
    }
    const dt = classifyDate(s);
    if (dt === 'date') dates++;
    else if (dt === 'datetime') datetimes++;
    if (notNumeric.length < 5) notNumeric.push(s.slice(0, 60));
  }
  const nullable = missing > 0;
  if (present === 0) return { name, type: 'empty', nullable: true, confidence: 1, mismatches: [] };
  const numeric = ints + floats;
  const pick = (type: ColumnType, matched: number, mismatches: string[]): ColumnSchema => ({ name, type, nullable, confidence: matched / present, mismatches });
  // Boolean only when actual true/false/yes/no words (or real booleans) appear; a 0/1 column stays integer.
  if (boolWords > 0 && bools === present) return pick('boolean', bools, []);
  if (numeric / present >= 0.95) return pick(floats > 0 ? 'float' : 'integer', numeric, notNumeric);
  if ((dates + datetimes) / present >= 0.95) return pick(datetimes > 0 ? 'datetime' : 'date', dates + datetimes, []);
  const ratio = distinct.size / present;
  if (distinct.size <= 50 || (ratio < 0.05 && maxLen <= 64)) return pick('categorical', present, []);
  return pick('text', present, []);
}

export function inferSchema(t: Table): Schema {
  return { columns: t.columns.map((c) => inferColumn(c.name, c.values)), rows: rowCount(t) };
}

/**
 * Converts string cells to typed cells following the schema: numeric strings
 * become numbers, boolean words become booleans, dates stay ISO strings
 * (dd/mm/yyyy is rewritten to yyyy-mm-dd). Cells that don't fit stay as they
 * are, so nothing is lost.
 */
export function coerceTable(t: Table, schema: Schema = inferSchema(t)): Table {
  return {
    columns: t.columns.map((c, i) => {
      const s = schema.columns[i];
      if (!s || s.name !== c.name) return c;
      return { name: c.name, values: c.values.map((v) => coerceCell(v, s.type)) };
    }),
  };
}

export function coerceCell(v: Cell, type: ColumnType): Cell {
  if (v === null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  switch (type) {
    case 'integer':
    case 'float': {
      const n = num(v);
      return Number.isNaN(n) ? v : n;
    }
    case 'boolean': {
      // Only literal true/false become booleans; yes/no, y/n and 1/0 keep their original text
      // so labels like "yes" are not rewritten (parseBool still reads them as booleans).
      if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
      return v;
    }
    case 'date': {
      if (typeof v !== 'string') return v;
      const m = DMY_RE.exec(v.trim());
      if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      return v.trim();
    }
    case 'datetime':
      return typeof v === 'string' ? v.trim() : v;
    default:
      return typeof v === 'string' ? v : String(v);
  }
}

export function isNumericType(t: ColumnType): boolean {
  return t === 'integer' || t === 'float';
}
