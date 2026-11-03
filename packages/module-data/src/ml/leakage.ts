/**
 * Leakage and split-quality checks, run before training. Each finding names
 * the evidence; none of them prove leakage, they point at where to look.
 */
import { type Table, getColumn, isMissing, num } from '../table.js';
import { inferColumn, isNumericType } from '../schema.js';
import { pairedNumeric, pearson } from '../stats.js';
import type { Split } from './split.js';

export interface LeakageFinding {
  level: 'info' | 'warn' | 'risk';
  code: string;
  column?: string;
  message: string;
}

function rowKey(t: Table, cols: string[], i: number): string {
  return JSON.stringify(cols.map((c) => getColumn(t, c).values[i]));
}

export function leakageChecks(t: Table, target: string, features: string[], split: Split, opts: { groupBy?: string; timeColumn?: string; task: 'classification' | 'regression' }): LeakageFinding[] {
  const out: LeakageFinding[] = [];
  const y = getColumn(t, target).values;
  if (features.includes(target)) out.push({ level: 'risk', code: 'target-in-features', column: target, message: `The target “${target}” is also a feature.` });
  // Duplicate feature rows on both sides of the split.
  const trainKeys = new Set(split.train.map((i) => rowKey(t, features, i)));
  let overlap = 0;
  for (const i of split.test) if (trainKeys.has(rowKey(t, features, i))) overlap++;
  if (overlap > 0) out.push({ level: overlap / split.test.length > 0.05 ? 'risk' : 'warn', code: 'duplicate-rows', message: `${overlap} test rows (${((overlap / split.test.length) * 100).toFixed(1)}%) have identical features to a training row, which inflates test scores. Deduplicate first or split by group.` });
  if (opts.groupBy) {
    const g = getColumn(t, opts.groupBy).values;
    const tg = new Set(split.train.map((i) => String(g[i])));
    const shared = new Set(split.test.filter((i) => !isMissing(g[i]) && tg.has(String(g[i]))).map((i) => String(g[i])));
    if (shared.size) out.push({ level: 'risk', code: 'group-overlap', column: opts.groupBy, message: `${shared.size} groups of “${opts.groupBy}” appear in both train and test.` });
  }
  const yIsNum = opts.task === 'regression';
  const ycodes = yIsNum ? y : (() => { const m = new Map<string, number>(); return y.map((v) => (isMissing(v) ? null : (m.has(String(v)) ? m.get(String(v))! : (m.set(String(v), m.size), m.size - 1)))); })();
  for (const f of features) {
    if (f === target) continue;
    const col = getColumn(t, f).values;
    const schema = inferColumn(f, split.train.map((i) => col[i]));
    // Feature that equals / determines the target.
    if (isNumericType(schema.type) || schema.type === 'boolean') {
      const [a, b] = pairedNumeric(split.train.map((i) => col[i]), split.train.map((i) => ycodes[i]));
      const r = pearson(a, b);
      if (a.length > 10 && Math.abs(r) > 0.98) out.push({ level: 'risk', code: 'target-proxy', column: f, message: `“${f}” correlates ${r.toFixed(3)} with the target on training rows. It may be computed from the target or recorded after it.` });
      else if (a.length > 10 && Math.abs(r) > 0.9 && yIsNum) out.push({ level: 'warn', code: 'high-correlation', column: f, message: `“${f}” correlates ${r.toFixed(3)} with the target. Check it is known at prediction time.` });
    }
    if (!yIsNum) {
      // A categorical feature where each value maps to exactly one class.
      const map = new Map<string, Set<string>>();
      for (const i of split.train) { if (isMissing(col[i]) || isMissing(y[i])) continue; const k = String(col[i]); (map.get(k) ?? map.set(k, new Set()).get(k)!).add(String(y[i])); }
      if (map.size >= 2 && map.size < split.train.length * 0.5 && [...map.values()].every((s) => s.size === 1)) out.push({ level: 'risk', code: 'target-proxy', column: f, message: `Every value of “${f}” maps to a single target class on training rows.` });
    }
    // Unique-per-row identifiers.
    const distinct = new Set(split.train.map((i) => String(col[i]))).size;
    if (split.train.length > 20 && distinct === split.train.length && (schema.type === 'text' || schema.type === 'integer') && /id$|_id|uuid|key|^index$/i.test(f)) out.push({ level: 'warn', code: 'identifier', column: f, message: `“${f}” is unique per row and looks like an identifier; models can memorise it.` });
    if (/(_after|outcome|result|label|target|future|next_)/i.test(f)) out.push({ level: 'info', code: 'name-hint', column: f, message: `“${f}” sounds like it may be recorded after the outcome. Confirm it is available at prediction time.` });
  }
  if (opts.timeColumn && features.includes(opts.timeColumn)) out.push({ level: 'info', code: 'time-feature', column: opts.timeColumn, message: `The time column is a feature; in a time split, test rows have values never seen in training.` });
  // Class balance.
  if (!yIsNum) {
    const c = new Map<string, number>();
    for (const i of split.train) if (!isMissing(y[i])) c.set(String(y[i]), (c.get(String(y[i])) ?? 0) + 1);
    const counts = [...c.values()];
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    if (counts.length > 1 && min / max < 0.1) out.push({ level: 'warn', code: 'imbalance', message: `Classes are imbalanced (smallest ${min}, largest ${max}). Accuracy will look good even for a useless model; read balanced accuracy, F1 and the confusion matrix.` });
    const testClasses = new Set(split.test.map((i) => String(y[i])));
    const missingInTest = [...c.keys()].filter((k) => !testClasses.has(k));
    if (missingInTest.length) out.push({ level: 'warn', code: 'class-missing-in-test', message: `Classes ${missingInTest.slice(0, 5).join(', ')} have no test rows; use a stratified split.` });
  }
  if (split.test.length < 30) out.push({ level: 'warn', code: 'small-test', message: `Only ${split.test.length} test rows; metrics will be noisy. Prefer cross-validation.` });
  const missingTarget = [...split.train, ...split.test].filter((i) => isMissing(y[i]) || (yIsNum && Number.isNaN(num(y[i])))).length;
  if (missingTarget) out.push({ level: 'info', code: 'missing-target', column: target, message: `${missingTarget} rows have no target value and were left out.` });
  return out;
}
