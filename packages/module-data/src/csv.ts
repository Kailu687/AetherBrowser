import { type Cell, type Table, DataError, LIMITS, fromMatrix, rowCount } from './table.js';

export interface CsvOptions {
  /** Delimiter; detected from the first lines when omitted. */
  delimiter?: string;
  /** First row is a header (default: detected). */
  header?: boolean;
  /** Stop after this many data rows. */
  maxRows?: number;
}

export interface CsvParseResult {
  table: Table;
  delimiter: string;
  header: boolean;
  /** Rows whose field count differed from the header (padded or truncated). */
  raggedRows: number;
  truncated: boolean;
}

const CANDIDATES = [',', ';', '\t', '|'];

/** Picks the delimiter that splits the first lines into the most consistent, >1 field counts (quote-aware). */
export function sniffDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  let best = ',';
  let bestScore = -1;
  for (const d of CANDIDATES) {
    const rows = parseRecords(sample, d, 20).rows;
    if (rows.length === 0) continue;
    const counts = rows.map((r) => r.length);
    const first = counts[0];
    if (first < 2) continue;
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = consistent * 10 + Math.min(first, 50) / 50;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/**
 * RFC 4180 record parser: quoted fields, doubled quotes, CRLF/LF/CR line ends,
 * newlines inside quotes. Linear time; no regex backtracking.
 */
export function parseRecords(text: string, delimiter: string, maxRecords = Infinity): { rows: string[][]; consumedAll: boolean } {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') throw new DataError('bad-delimiter', 'Delimiter must be one character other than a quote or newline.');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  const n = text.length;
  let inQuotes = false;
  let fieldStart = true;
  const d = delimiter.charCodeAt(0);
  while (i < n) {
    const ch = text.charCodeAt(i);
    if (inQuotes) {
      if (ch === 34) {
        if (text.charCodeAt(i + 1) === 34) {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      // Bulk-copy up to the next quote.
      const q = text.indexOf('"', i);
      const end = q === -1 ? n : q;
      field += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === 34 && fieldStart) {
      inQuotes = true;
      fieldStart = false;
      i++;
      continue;
    }
    if (ch === d) {
      row.push(field);
      field = '';
      fieldStart = true;
      i++;
      continue;
    }
    if (ch === 10 || ch === 13) {
      row.push(field);
      field = '';
      fieldStart = true;
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
      if (ch === 13 && text.charCodeAt(i + 1) === 10) i++;
      i++;
      if (rows.length >= maxRecords) return { rows, consumedAll: i >= n };
      continue;
    }
    field += text[i];
    fieldStart = false;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
  }
  return { rows, consumedAll: true };
}

function looksNumeric(s: string): boolean {
  return /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(s);
}

/** A header row is likely when no field of row 0 is numeric but some field of row 1 is. */
function detectHeader(rows: string[][]): boolean {
  if (rows.length < 2) return true;
  const r0 = rows[0];
  const r1 = rows[1];
  const r0Numeric = r0.some((f) => looksNumeric(f));
  const r1Numeric = r1.some((f) => looksNumeric(f));
  if (!r0Numeric && r1Numeric) return true;
  if (r0Numeric) return false;
  // All text: header if names are unique and non-empty.
  return new Set(r0).size === r0.length && r0.every((f) => f.trim() !== '');
}

export function parseCsv(textIn: string, opts: CsvOptions = {}): CsvParseResult {
  const text = textIn.charCodeAt(0) === 0xfeff ? textIn.slice(1) : textIn;
  const delimiter = opts.delimiter ?? sniffDelimiter(text);
  const maxRows = Math.max(1, Math.min(opts.maxRows ?? Infinity, Number.MAX_SAFE_INTEGER));
  const { rows, consumedAll } = parseRecords(text, delimiter, maxRows + 1);
  if (rows.length === 0) return { table: { columns: [] }, delimiter, header: true, raggedRows: 0, truncated: false };
  const header = opts.header ?? detectHeader(rows);
  const width = Math.max(...rows.slice(0, 1000).map((r) => r.length));
  if (width > LIMITS.maxColumns) throw new DataError('too-many-columns', `More than ${LIMITS.maxColumns} columns.`);
  const names = header ? rows[0].slice() : Array.from({ length: width }, (_, i) => `column_${i + 1}`);
  while (names.length < width) names.push(`column_${names.length + 1}`);
  let data = header ? rows.slice(1) : rows;
  let truncated = !consumedAll;
  if (data.length > maxRows) {
    data = data.slice(0, maxRows);
    truncated = true;
  }
  if (data.length * names.length > LIMITS.maxCells) throw new DataError('too-large', `More than ${LIMITS.maxCells.toLocaleString('en')} cells. Load a sample (max rows) instead.`);
  let ragged = 0;
  const cells: Cell[][] = data.map((r) => {
    if (r.length !== names.length) ragged++;
    const out: Cell[] = new Array(names.length);
    for (let c = 0; c < names.length; c++) {
      const v = r[c];
      out[c] = v === undefined || v === '' ? null : v.length > LIMITS.maxCellChars ? v.slice(0, LIMITS.maxCellChars) : v;
    }
    return out;
  });
  return { table: fromMatrix(names, cells), delimiter, header, raggedRows: ragged, truncated };
}

/**
 * Cells starting with = + - @ (or tab / CR) are prefixed with a quote so a
 * spreadsheet opening the export does not run them as formulas (CSV injection).
 * Plain negative numbers are left alone.
 */
export function neutraliseFormula(s: string): string {
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return `'${s}`;
  return s;
}

export function formatCsvField(v: Cell, delimiter = ',', protect = true): string {
  if (v === null) return '';
  let s = typeof v === 'string' ? v : String(v);
  if (protect && typeof v === 'string') s = neutraliseFormula(s);
  if (s.includes('"') || s.includes(delimiter) || s.includes('\n') || s.includes('\r') || /^\s|\s$/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(t: Table, opts: { delimiter?: string; protectFormulas?: boolean; maxRows?: number } = {}): string {
  const d = opts.delimiter ?? ',';
  const protect = opts.protectFormulas !== false;
  const lines = [t.columns.map((c) => formatCsvField(c.name, d, protect)).join(d)];
  const n = Math.min(rowCount(t), opts.maxRows ?? Infinity);
  for (let i = 0; i < n; i++) lines.push(t.columns.map((c) => formatCsvField(c.values[i], d, protect)).join(d));
  return lines.join('\r\n') + '\r\n';
}
