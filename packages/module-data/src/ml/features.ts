/**
 * Feature preprocessing, fitted on training rows only so test rows never
 * influence imputation values, scaling or category lists (a common source of
 * leakage when cleaning is done on the full dataset first).
 */
import { type Cell, type Table, DataError, getColumn, isMissing, num } from '../table.js';
import { inferColumn, isNumericType, parseBool } from '../schema.js';
import { mean, quantileSorted, sortedCopy, std } from '../stats.js';

export type FeatureSpec =
  | { name: string; kind: 'numeric'; median: number; mean: number; std: number; missingIndicator: boolean }
  | { name: string; kind: 'categorical'; categories: string[]; other: boolean }
  /** Free text: TF-IDF over a vocabulary learned from the training rows (L2-normalised). */
  | { name: string; kind: 'text'; vocab: string[]; idf: number[] };

export interface Preprocessor {
  features: FeatureSpec[];
  /** Names of the expanded model inputs, in order. */
  outputNames: string[];
  scale: boolean;
}

export interface TargetSpec {
  name: string;
  task: 'classification' | 'regression';
  /** Class labels (classification), index = class id. */
  classes?: string[];
}

const MAX_CATEGORIES = 50;
export const TEXT_VOCAB = 100;
const MAX_TOKENS_PER_CELL = 2000;

/** Lower-cased word tokens (letters/digits in any script), 2–30 characters. */
export function tokenize(v: Cell): string[] {
  if (isMissing(v)) return [];
  const out: string[] = [];
  for (const m of String(v).toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'_-]{1,29}/gu)) {
    out.push(m[0]);
    if (out.length >= MAX_TOKENS_PER_CELL) break;
  }
  return out;
}

function fitText(name: string, vals: Cell[]): FeatureSpec {
  const df = new Map<string, number>();
  for (const v of vals) for (const tok of new Set(tokenize(v))) df.set(tok, (df.get(tok) ?? 0) + 1);
  const n = vals.length;
  const vocab = [...df.entries()].filter(([, c]) => c >= 2 && c < n * 0.95).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, TEXT_VOCAB).map(([k]) => k);
  return { name, kind: 'text', vocab, idf: vocab.map((w) => Math.log((1 + n) / (1 + df.get(w)!)) + 1) };
}

function textVector(f: Extract<FeatureSpec, { kind: 'text' }>, v: Cell, index: Map<string, number>): number[] {
  const out = new Array<number>(f.vocab.length).fill(0);
  for (const tok of tokenize(v)) { const j = index.get(tok); if (j !== undefined) out[j] += 1; }
  let norm = 0;
  for (let j = 0; j < out.length; j++) { out[j] *= f.idf[j]; norm += out[j] * out[j]; }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let j = 0; j < out.length; j++) out[j] /= norm;
  return out;
}
const vocabIndex = new WeakMap<object, Map<string, number>>();
function indexOf(f: Extract<FeatureSpec, { kind: 'text' }>): Map<string, number> {
  let m = vocabIndex.get(f);
  if (!m) { m = new Map(f.vocab.map((w, i) => [w, i])); vocabIndex.set(f, m); }
  return m;
}
export const ML_LIMITS = { maxRows: 500_000, maxInputs: 1_000, maxMatrixCells: 10_000_000, maxClasses: 100 };

export function fitPreprocessor(t: Table, featureNames: string[], rows: number[], opts: { scale?: boolean } = {}): Preprocessor {
  const scale = opts.scale !== false;
  const features: FeatureSpec[] = [];
  for (const name of featureNames) {
    const all = getColumn(t, name).values;
    const vals = rows.map((i) => all[i]);
    const schema = inferColumn(name, vals);
    if (isNumericType(schema.type) || schema.type === 'boolean') {
      const xs: number[] = [];
      let missing = 0;
      for (const v of vals) {
        const x = schema.type === 'boolean' ? boolNum(v) : num(v);
        if (Number.isNaN(x)) missing++;
        else xs.push(x);
      }
      const med = xs.length ? quantileSorted(sortedCopy(xs), 0.5) : 0;
      features.push({ name, kind: 'numeric', median: med, mean: xs.length ? mean(xs) : 0, std: xs.length > 1 ? std(xs) || 1 : 1, missingIndicator: missing > 0 });
    } else if (schema.type === 'text') {
      features.push(fitText(name, vals));
    } else {
      const counts = new Map<string, number>();
      for (const v of vals) if (!isMissing(v)) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      features.push({ name, kind: 'categorical', categories: sorted.slice(0, MAX_CATEGORIES).map(([k]) => k), other: sorted.length > MAX_CATEGORIES || vals.some(isMissing) });
    }
  }
  const outputNames: string[] = [];
  for (const f of features) {
    if (f.kind === 'numeric') {
      outputNames.push(f.name);
      if (f.missingIndicator) outputNames.push(`${f.name} (missing)`);
    } else if (f.kind === 'text') {
      for (const w of f.vocab) outputNames.push(`${f.name}~${w}`);
    } else {
      for (const c of f.categories) outputNames.push(`${f.name}=${c}`);
      if (f.other) outputNames.push(`${f.name}=(other/missing)`);
    }
  }
  if (outputNames.length > ML_LIMITS.maxInputs) throw new DataError('ml', `Features expand to ${outputNames.length} model inputs (limit ${ML_LIMITS.maxInputs}). Drop high-cardinality text columns.`);
  return { features, outputNames, scale };
}

function boolNum(v: Cell): number {
  const b = parseBool(v);
  return b === null ? num(v) : b ? 1 : 0;
}

export function transformRow(p: Preprocessor, get: (name: string) => Cell): number[] {
  const out: number[] = [];
  for (const f of p.features) {
    const v = get(f.name);
    if (f.kind === 'numeric') {
      let x = boolNum(v);
      const miss = Number.isNaN(x);
      if (miss) x = f.median;
      out.push(p.scale ? (x - f.mean) / f.std : x);
      if (f.missingIndicator) out.push(miss ? 1 : 0);
    } else if (f.kind === 'text') {
      for (const x of textVector(f, v, indexOf(f))) out.push(x);
    } else {
      const s = isMissing(v) ? null : String(v);
      let hit = false;
      for (const c of f.categories) {
        const on = s === c;
        if (on) hit = true;
        out.push(on ? 1 : 0);
      }
      if (f.other) out.push(hit ? 0 : 1);
    }
  }
  return out;
}

export function transform(p: Preprocessor, t: Table, rows: number[]): number[][] {
  const cols = new Map(p.features.map((f) => [f.name, getColumn(t, f.name).values] as const));
  return rows.map((i) => transformRow(p, (n) => cols.get(n)![i]));
}

export function fitTarget(t: Table, name: string, task: 'classification' | 'regression' | 'auto', rows: number[]): TargetSpec {
  const vals = rows.map((i) => getColumn(t, name).values[i]);
  const schema = inferColumn(name, vals);
  const distinct = new Set(vals.filter((v) => !isMissing(v)).map(String));
  const resolved = task === 'auto' ? (isNumericType(schema.type) && distinct.size > 20 ? 'regression' : 'classification') : task;
  if (resolved === 'regression') {
    if (!isNumericType(schema.type)) throw new DataError('ml', `Regression needs a numeric target; “${name}” is ${schema.type}.`);
    return { name, task: 'regression' };
  }
  if (distinct.size < 2) throw new DataError('ml', `The target “${name}” has fewer than two classes in the training rows.`);
  if (distinct.size > ML_LIMITS.maxClasses) throw new DataError('ml', `The target has ${distinct.size} classes (limit ${ML_LIMITS.maxClasses}). Is it really a classification target?`);
  const classes = [...distinct].sort((a, b) => { const x = Number(a); const y = Number(b); return !Number.isNaN(x) && !Number.isNaN(y) ? x - y : a < b ? -1 : a > b ? 1 : 0; });
  return { name, task: 'classification', classes };
}

/** Encoded target values; rows with a missing (or unseen) target get NaN / -1 and are dropped by the caller. */
export function encodeTarget(spec: TargetSpec, t: Table, rows: number[]): number[] {
  const vals = getColumn(t, spec.name).values;
  if (spec.task === 'regression') return rows.map((i) => num(vals[i]));
  const idx = new Map(spec.classes!.map((c, k) => [c, k]));
  return rows.map((i) => (isMissing(vals[i]) ? -1 : idx.get(String(vals[i])) ?? -1));
}
