/**
 * The in-memory table every part of the Data module works on.
 *
 * Column-oriented: each column holds one array of cells. Cells are JSON
 * primitives so a table can cross IPC (structured clone) and be stored as JSON
 * without conversion. Dates stay ISO strings; the inferred schema says which
 * string columns are dates.
 */

export type Cell = string | number | boolean | null;

export interface Column {
  name: string;
  values: Cell[];
}

export interface Table {
  columns: Column[];
}

/** Hard limits that keep the main process responsive and memory bounded. */
export const LIMITS = {
  /** Largest file the module will read (bytes). */
  maxFileBytes: 512 * 1024 * 1024,
  /** Largest number of cells (rows × columns) held in one table. */
  maxCells: 20_000_000,
  maxColumns: 2_000,
  maxColumnName: 256,
  /** Longest single cell string kept; longer strings are truncated and flagged. */
  maxCellChars: 32_768,
  /** Rows sent to the UI in one page. */
  maxPageRows: 1_000,
} as const;

export class DataError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'DataError';
  }
}

export function rowCount(t: Table): number {
  return t.columns[0]?.values.length ?? 0;
}

export function columnNames(t: Table): string[] {
  return t.columns.map((c) => c.name);
}

export function getColumn(t: Table, name: string): Column {
  const c = t.columns.find((x) => x.name === name);
  if (!c) throw new DataError('no-column', `No column named “${name}”.`);
  return c;
}

export function hasColumn(t: Table, name: string): boolean {
  return t.columns.some((x) => x.name === name);
}

/** Builds a table from row objects, keeping first-seen key order. Keys like __proto__ are ordinary strings here. */
export function fromRows(rows: Array<Record<string, unknown>>, opts: { maxColumns?: number } = {}): Table {
  const names: string[] = [];
  const index = new Map<string, number>();
  const maxColumns = opts.maxColumns ?? LIMITS.maxColumns;
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!index.has(k)) {
        if (names.length >= maxColumns) throw new DataError('too-many-columns', `More than ${maxColumns} columns.`);
        index.set(k, names.length);
        names.push(k);
      }
    }
  }
  const cols: Column[] = names.map((n) => ({ name: n, values: new Array<Cell>(rows.length) }));
  rows.forEach((r, i) => {
    for (let c = 0; c < names.length; c++) cols[c].values[i] = toCell(Object.prototype.hasOwnProperty.call(r, names[c]) ? r[names[c]] : null);
  });
  return { columns: uniqueNames(cols) };
}

export function fromMatrix(header: string[], rows: Cell[][]): Table {
  const cols: Column[] = header.map((name, c) => ({ name, values: rows.map((r) => (c < r.length ? r[c] : null)) }));
  return { columns: uniqueNames(cols) };
}

/** Rows [start, start+count) as arrays, for paging in the UI. */
export function sliceRows(t: Table, start: number, count: number): Cell[][] {
  const n = rowCount(t);
  const s = Math.max(0, Math.min(n, Math.floor(start)));
  const e = Math.max(s, Math.min(n, s + Math.min(count, LIMITS.maxPageRows)));
  const out: Cell[][] = [];
  for (let i = s; i < e; i++) out.push(t.columns.map((c) => c.values[i]));
  return out;
}

export function rowObject(t: Table, i: number): Record<string, Cell> {
  const o: Record<string, Cell> = Object.create(null);
  for (const c of t.columns) o[c.name] = c.values[i];
  return o;
}

export function selectRows(t: Table, idx: ArrayLike<number>): Table {
  return {
    columns: t.columns.map((c) => {
      const v = new Array<Cell>(idx.length);
      for (let i = 0; i < idx.length; i++) v[i] = c.values[idx[i]];
      return { name: c.name, values: v };
    }),
  };
}

export function cloneTable(t: Table): Table {
  return { columns: t.columns.map((c) => ({ name: c.name, values: c.values.slice() })) };
}

/** Normalises any JS value to a Cell. Objects become JSON text; non-finite numbers become null. */
export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > LIMITS.maxCellChars ? v.slice(0, LIMITS.maxCellChars) : v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  try {
    const s = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
    return s === undefined ? null : s.length > LIMITS.maxCellChars ? s.slice(0, LIMITS.maxCellChars) : s;
  } catch {
    return String(v);
  }
}

/** Makes column names non-empty, bounded and unique (a, a_2, a_3 ...). */
export function uniqueNames(cols: Column[]): Column[] {
  const seen = new Set<string>();
  return cols.map((c, i) => {
    let base = String(c.name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, LIMITS.maxColumnName) || `column_${i + 1}`;
    let name = base;
    let k = 2;
    while (seen.has(name)) name = `${base}_${k++}`;
    seen.add(name);
    return name === c.name ? c : { name, values: c.values };
  });
}

export function checkSize(t: Table): void {
  const cells = rowCount(t) * t.columns.length;
  if (t.columns.length > LIMITS.maxColumns) throw new DataError('too-many-columns', `More than ${LIMITS.maxColumns} columns.`);
  if (cells > LIMITS.maxCells) throw new DataError('too-large', `Dataset has ${cells.toLocaleString('en')} cells; the limit is ${LIMITS.maxCells.toLocaleString('en')}. Filter or sample it in Python first.`);
}

export function isMissing(v: Cell): boolean {
  return v === null || (typeof v === 'string' && v.trim() === '');
}

/** Numeric view of a cell: numbers, numeric strings and booleans (1/0); otherwise NaN. */
export function num(v: Cell): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return NaN;
    const n = Number(s.replace(/,/g, ''));
    return Number.isFinite(n) && /^[+-]?(\d[\d,]*\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? n : NaN;
  }
  return NaN;
}
