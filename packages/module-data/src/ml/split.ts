import { type Cell, DataError, isMissing } from '../table.js';
import { dateValue } from '../schema.js';
import { mulberry32, shuffleInPlace } from '../rng.js';

export type SplitStrategy = 'random' | 'stratified' | 'group' | 'time';

export interface SplitConfig {
  strategy: SplitStrategy;
  testFraction: number;
  seed: number;
  /** Stratify by this column (default: the target). */
  stratifyBy?: string;
  /** Rows sharing a group id stay on the same side (e.g. a patient or a user). */
  groupBy?: string;
  /** Train on earlier rows, test on later rows by this column. */
  timeColumn?: string;
}

export interface Split {
  train: number[];
  test: number[];
}

function check(fraction: number) {
  if (!(fraction > 0 && fraction < 0.9)) throw new DataError('ml', 'Test fraction must be between 0 and 0.9.');
}

export function randomSplit(rows: number[], fraction: number, seed: number): Split {
  check(fraction);
  const idx = shuffleInPlace(rows.slice(), mulberry32(seed));
  const k = Math.max(1, Math.round(idx.length * fraction));
  return { train: idx.slice(k).sort((a, b) => a - b), test: idx.slice(0, k).sort((a, b) => a - b) };
}

export function stratifiedSplit(rows: number[], labels: Cell[], fraction: number, seed: number): Split {
  check(fraction);
  const rnd = mulberry32(seed);
  const by = new Map<string, number[]>();
  for (const i of rows) {
    const k = isMissing(labels[i]) ? '\u0000' : String(labels[i]);
    (by.get(k) ?? by.set(k, []).get(k)!).push(i);
  }
  const train: number[] = [];
  const test: number[] = [];
  for (const g of [...by.keys()].sort()) {
    const idx = shuffleInPlace(by.get(g)!, rnd);
    const k = idx.length > 1 ? Math.max(1, Math.round(idx.length * fraction)) : 0;
    test.push(...idx.slice(0, k));
    train.push(...idx.slice(k));
  }
  return { train: train.sort((a, b) => a - b), test: test.sort((a, b) => a - b) };
}

export function groupSplit(rows: number[], groups: Cell[], fraction: number, seed: number): Split {
  check(fraction);
  const by = new Map<string, number[]>();
  for (const i of rows) {
    const k = isMissing(groups[i]) ? `\u0000${i}` : String(groups[i]);
    (by.get(k) ?? by.set(k, []).get(k)!).push(i);
  }
  const keys = shuffleInPlace([...by.keys()].sort(), mulberry32(seed));
  const target = rows.length * fraction;
  const test: number[] = [];
  const train: number[] = [];
  for (const k of keys) (test.length < target ? test : train).push(...by.get(k)!);
  if (!train.length || !test.length) throw new DataError('ml', 'Not enough groups to split.');
  return { train: train.sort((a, b) => a - b), test: test.sort((a, b) => a - b) };
}

export function timeSplit(rows: number[], times: Cell[], fraction: number): Split {
  check(fraction);
  const t = (i: number) => { const d = dateValue(times[i]); return Number.isNaN(d) ? Number(times[i]) : d; };
  const valid = rows.filter((i) => Number.isFinite(t(i)));
  if (valid.length < rows.length * 0.9) throw new DataError('ml', 'The time column has too many missing or unreadable values.');
  const sorted = valid.slice().sort((a, b) => t(a) - t(b) || a - b);
  const k = Math.round(sorted.length * (1 - fraction));
  return { train: sorted.slice(0, k).sort((a, b) => a - b), test: sorted.slice(k).sort((a, b) => a - b) };
}

/** Fold assignment for k-fold CV over `rows` (stratified when labels are given; grouped when groups are given). */
export function kFolds(rows: number[], k: number, seed: number, opts: { labels?: Cell[]; groups?: Cell[] } = {}): Split[] {
  if (k < 2 || k > 20) throw new DataError('ml', 'Folds must be between 2 and 20.');
  if (rows.length < k) throw new DataError('ml', 'Fewer rows than folds.');
  const rnd = mulberry32(seed);
  const fold = new Map<number, number>();
  if (opts.groups) {
    const by = new Map<string, number[]>();
    for (const i of rows) { const g = isMissing(opts.groups[i]) ? `\u0000${i}` : String(opts.groups[i]); (by.get(g) ?? by.set(g, []).get(g)!).push(i); }
    if (by.size < k) throw new DataError('ml', `Only ${by.size} groups for ${k} folds.`);
    shuffleInPlace([...by.keys()].sort(), rnd).forEach((g, j) => by.get(g)!.forEach((i) => fold.set(i, j % k)));
  } else if (opts.labels) {
    const by = new Map<string, number[]>();
    for (const i of rows) { const l = String(opts.labels[i]); (by.get(l) ?? by.set(l, []).get(l)!).push(i); }
    let offset = 0;
    for (const l of [...by.keys()].sort()) { shuffleInPlace(by.get(l)!, rnd).forEach((i, j) => fold.set(i, (j + offset) % k)); offset += by.get(l)!.length; }
  } else {
    shuffleInPlace(rows.slice(), rnd).forEach((i, j) => fold.set(i, j % k));
  }
  return Array.from({ length: k }, (_, f) => ({ train: rows.filter((i) => fold.get(i) !== f), test: rows.filter((i) => fold.get(i) === f) }));
}
