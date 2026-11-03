import { createHash } from 'node:crypto';
import { type Table, DataError, LIMITS, checkSize } from './table.js';
import { parseCsv } from './csv.js';
import { parseJson, parseJsonLines } from './jsonio.js';
import { parseParquet } from './parquet.js';
import { coerceTable, inferSchema } from './schema.js';

export type DataFormat = 'csv' | 'tsv' | 'json' | 'jsonl' | 'parquet';
export const SUPPORTED_EXTENSIONS = ['csv', 'tsv', 'txt', 'json', 'jsonl', 'ndjson', 'parquet'];

export interface LoadedDataset {
  table: Table;
  format: DataFormat;
  sha256: string;
  bytes: number;
  truncated: boolean;
  notes: string[];
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function formatFromName(name: string): DataFormat | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'csv' || ext === 'txt') return 'csv';
  if (ext === 'tsv') return 'tsv';
  if (ext === 'json') return 'json';
  if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl';
  if (ext === 'parquet') return 'parquet';
  return null;
}

/** Detects the format from content when the extension is missing or unknown. */
export function sniffFormat(bytes: Uint8Array): DataFormat {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x52 && bytes[3] === 0x31) return 'parquet';
  const head = new TextDecoder().decode(bytes.subarray(0, 2048)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('[') || (head.startsWith('{') && !/\}\s*\r?\n\s*\{/.test(head))) return 'json';
  if (head.startsWith('{')) return 'jsonl';
  return 'csv';
}

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  let zeros = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) zeros++;
  return zeros > 0;
}

export async function loadDataset(bytes: Uint8Array, name: string, opts: { maxRows?: number; format?: DataFormat } = {}): Promise<LoadedDataset> {
  if (bytes.byteLength > LIMITS.maxFileBytes) throw new DataError('too-large', `File is larger than ${LIMITS.maxFileBytes / 1024 / 1024} MB.`);
  const format = opts.format ?? formatFromName(name) ?? sniffFormat(bytes);
  const notes: string[] = [];
  let table: Table;
  let truncated = false;
  if (format === 'parquet') {
    const r = await parseParquet(bytes, opts);
    table = r.table;
    truncated = r.truncated;
    notes.push(`Parquet, ${r.totalRows.toLocaleString('en')} rows, codecs ${r.codecs.join(', ') || 'none'}${r.createdBy ? `, written by ${r.createdBy}` : ''}.`);
  } else {
    if (looksBinary(bytes)) throw new DataError('binary', 'This file looks binary, not text. Supported: CSV, TSV, JSON, JSON Lines and Parquet.');
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (text.includes('�')) notes.push('Some bytes were not valid UTF-8 and were replaced with “�”. Re-save the file as UTF-8 if text looks wrong.');
    if (format === 'json' || format === 'jsonl') {
      const r = format === 'jsonl' ? parseJsonLines(text, opts.maxRows) : parseJson(text, opts);
      table = r.table;
      truncated = r.truncated;
      if (r.path) notes.push(`Records read from “${r.path}”.`);
    } else {
      const r = parseCsv(text, { delimiter: format === 'tsv' ? '\t' : undefined, maxRows: opts.maxRows });
      table = r.table;
      truncated = r.truncated;
      notes.push(`Delimiter ${JSON.stringify(r.delimiter)}, ${r.header ? 'first row is the header' : 'no header row'}.`);
      if (r.raggedRows) notes.push(`${r.raggedRows} rows had a different number of fields than the header and were padded or cut.`);
    }
  }
  checkSize(table);
  table = coerceTable(table, inferSchema(table));
  if (truncated) notes.push(`Only the first ${opts.maxRows?.toLocaleString('en') ?? 'part'} rows were loaded.`);
  return { table, format, sha256: sha256(bytes), bytes: bytes.byteLength, truncated, notes };
}
