import { type Table, DataError, LIMITS, fromRows, rowCount, toCell } from './table.js';

export interface JsonParseResult {
  table: Table;
  shape: 'records' | 'columns' | 'lines' | 'nested';
  /** Path inside the document the records came from (e.g. "data.items"). */
  path: string;
  truncated: boolean;
}

const MAX_DEPTH = 3;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Flattens nested objects to dotted keys (depth-limited). Arrays and deeper objects become JSON text. */
export function flattenRecord(value: unknown, maxDepth = MAX_DEPTH): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  const walk = (v: unknown, prefix: string, depth: number) => {
    if (isPlainObject(v) && depth < maxDepth) {
      const keys = Object.keys(v as object);
      if (keys.length === 0 && prefix) out[prefix] = null;
      for (const k of keys) walk((v as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k, depth + 1);
      return;
    }
    out[prefix || 'value'] = v;
  };
  walk(value, '', 0);
  return out;
}

function findRecords(doc: unknown, path: string[] = []): { rows: unknown[]; path: string } | null {
  if (Array.isArray(doc)) return { rows: doc, path: path.join('.') };
  if (doc && typeof doc === 'object') {
    // Prefer the largest array of objects among the top-level (or nested) properties.
    let best: { rows: unknown[]; path: string } | null = null;
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
      if (path.length >= 3) break;
      const found = findRecords(v, [...path, k]);
      if (found && found.rows.length > (best?.rows.length ?? 0) && found.rows.some((r) => r && typeof r === 'object')) best = found;
    }
    return best;
  }
  return null;
}

function isColumnar(doc: unknown): doc is Record<string, unknown[]> {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  const vals = Object.values(doc as Record<string, unknown>);
  if (vals.length < 1 || !vals.every(Array.isArray)) return false;
  const len = (vals[0] as unknown[]).length;
  return vals.every((v) => (v as unknown[]).length === len) && (vals[0] as unknown[]).every((x) => x === null || typeof x !== 'object');
}

export function parseJson(text: string, opts: { maxRows?: number } = {}): JsonParseResult {
  const maxRows = opts.maxRows ?? Infinity;
  const trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) return { table: { columns: [] }, shape: 'records', path: '', truncated: false };
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return parseJsonLines(trimmed, maxRows);
  }
  if (isColumnar(doc)) {
    const names = Object.keys(doc);
    if (names.length > LIMITS.maxColumns) throw new DataError('too-many-columns', `More than ${LIMITS.maxColumns} columns.`);
    const n = Math.min((doc[names[0]] as unknown[]).length, maxRows);
    const table: Table = { columns: names.map((name) => ({ name, values: (doc as Record<string, unknown[]>)[name].slice(0, n).map(toCell) })) };
    return { table, shape: 'columns', path: '', truncated: n < (doc[names[0]] as unknown[]).length };
  }
  const found = findRecords(doc);
  if (!found) {
    if (doc && typeof doc === 'object') return { table: fromRows([flattenRecord(doc)]), shape: 'nested', path: '', truncated: false };
    throw new DataError('no-records', 'This JSON has no list of records to show as a table.');
  }
  const rows = found.rows.slice(0, maxRows).map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? flattenRecord(r) : { value: r }));
  checkCells(rows);
  return { table: fromRows(rows), shape: found.path ? 'nested' : 'records', path: found.path, truncated: found.rows.length > rows.length };
}

export function parseJsonLines(text: string, maxRows = Infinity): JsonParseResult {
  const rows: Record<string, unknown>[] = [];
  const lines = text.split(/\r?\n/);
  let lineNo = 0;
  let truncated = false;
  for (const line of lines) {
    lineNo++;
    const s = line.trim();
    if (!s) continue;
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch {
      throw new DataError('bad-json', `Not valid JSON or JSON Lines (line ${lineNo}).`);
    }
    rows.push(v && typeof v === 'object' && !Array.isArray(v) ? flattenRecord(v) : { value: v });
  }
  checkCells(rows);
  return { table: fromRows(rows), shape: 'lines', path: '', truncated };
}

function checkCells(rows: Record<string, unknown>[]): void {
  const sample = rows.slice(0, 100);
  const width = sample.reduce((m, r) => Math.max(m, Object.keys(r).length), 0);
  if (rows.length * width > LIMITS.maxCells) throw new DataError('too-large', 'Too many cells; load fewer rows.');
}

export function toJsonRecords(t: Table, maxRows = Infinity): string {
  const n = Math.min(rowCount(t), maxRows);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const o: Record<string, unknown> = {};
    for (const c of t.columns) Object.defineProperty(o, c.name, { value: c.values[i], enumerable: true, writable: true, configurable: true });
    out.push(JSON.stringify(o));
  }
  return `[\n${out.join(',\n')}\n]\n`;
}

export function toJsonLines(t: Table): string {
  const n = rowCount(t);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const o: Record<string, unknown> = {};
    for (const c of t.columns) Object.defineProperty(o, c.name, { value: c.values[i], enumerable: true, writable: true, configurable: true });
    out.push(JSON.stringify(o));
  }
  return out.join('\n') + '\n';
}
