import { parquetMetadata, parquetReadObjects, parquetSchema } from 'hyparquet';
import * as zlib from 'node:zlib';
import { type Table, DataError, LIMITS, fromRows } from './table.js';
import { flattenRecord } from './jsonio.js';

export interface ParquetParseResult {
  table: Table;
  totalRows: number;
  truncated: boolean;
  codecs: string[];
  createdBy?: string;
}

type Decompress = (input: Uint8Array, outputLength: number) => Uint8Array;

/** Extra codecs from Node's zlib (hyparquet handles UNCOMPRESSED and SNAPPY itself). */
function compressors(): Record<string, Decompress> {
  const z = zlib as unknown as Record<string, ((b: Uint8Array) => Uint8Array) | undefined>;
  const c: Record<string, Decompress> = {
    GZIP: (input) => new Uint8Array(zlib.gunzipSync(input)),
    BROTLI: (input) => new Uint8Array(zlib.brotliDecompressSync(input)),
  };
  if (typeof z.zstdDecompressSync === 'function') c.ZSTD = (input) => new Uint8Array(z.zstdDecompressSync!(input));
  return c;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export const PARQUET_SUPPORTED_CODECS = ['UNCOMPRESSED', 'SNAPPY', 'GZIP', 'BROTLI', 'ZSTD'];

export async function parseParquet(bytes: Uint8Array, opts: { maxRows?: number } = {}): Promise<ParquetParseResult> {
  if (bytes.byteLength < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'PAR1' || String.fromCharCode(...bytes.subarray(bytes.byteLength - 4)) !== 'PAR1') {
    throw new DataError('bad-parquet', 'Not a Parquet file (missing PAR1 magic bytes).');
  }
  const file = toArrayBuffer(bytes);
  let meta;
  try {
    meta = parquetMetadata(file);
  } catch (e) {
    throw new DataError('bad-parquet', `Could not read Parquet metadata: ${(e as Error).message}`);
  }
  const totalRows = Number(meta.num_rows);
  const codecs = new Set<string>();
  for (const rg of meta.row_groups) for (const col of rg.columns) if (col.meta_data) codecs.add(String(col.meta_data.codec));
  const available = compressors();
  for (const c of codecs) {
    if (!PARQUET_SUPPORTED_CODECS.includes(c) || (c === 'ZSTD' && !available.ZSTD)) throw new DataError('parquet-codec', `Parquet compression ${c} is not supported here. Re-save with Snappy, Gzip or Zstd.`);
  }
  const width = parquetSchema(meta).children.length;
  if (width > LIMITS.maxColumns) throw new DataError('too-many-columns', `More than ${LIMITS.maxColumns} columns.`);
  const limit = Math.min(totalRows, opts.maxRows ?? totalRows, Math.floor(LIMITS.maxCells / Math.max(1, width)));
  let rows: Record<string, unknown>[];
  try {
    rows = (await parquetReadObjects({ file, metadata: meta, rowStart: 0, rowEnd: limit, compressors: available as never })) as Record<string, unknown>[];
  } catch (e) {
    throw new DataError('bad-parquet', `Could not read Parquet data: ${(e as Error).message}`);
  }
  const flat = rows.map((r) => flattenRecord(r, 2));
  return { table: fromRows(flat), totalRows, truncated: limit < totalRows, codecs: [...codecs], createdBy: meta.created_by };
}
