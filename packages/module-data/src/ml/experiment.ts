/**
 * One end-to-end training run: split → leakage checks → preprocessing fitted on
 * train → model → test metrics (+ optional cross-validation and hyperparameter
 * search on the training rows only) → importance and error analysis.
 * Everything in the result comes from the actual computation; nothing is
 * estimated or filled in.
 */
import { type Cell, type Table, DataError, getColumn, isMissing, num, rowCount } from '../table.js';
import { mulberry32, shuffleInPlace } from '../rng.js';
import { type Preprocessor, type TargetSpec, ML_LIMITS, encodeTarget, fitPreprocessor, fitTarget, transform, transformRow } from './features.js';
import { type FittedModel, type ModelType, MODEL_INFO, TrainContext, clampParams, fitModel, predictLabels, predictRaw } from './models.js';
import { type Metrics, classificationMetrics, primaryScore, regressionMetrics, rocCurve } from './metrics.js';
import { type Split, type SplitConfig, groupSplit, kFolds, randomSplit, stratifiedSplit, timeSplit } from './split.js';
import { type LeakageFinding, leakageChecks } from './leakage.js';

export interface ExperimentConfig {
  target: string;
  features: string[];
  task: 'classification' | 'regression' | 'auto';
  model: ModelType;
  params?: Record<string, unknown>;
  split: SplitConfig;
  /** k for cross-validation on the training rows (0 = off). */
  cvFolds?: number;
  search?: { method: 'grid' | 'random'; space: Record<string, Array<number | string>>; maxTrials?: number };
  scale?: boolean;
  /** 'balanced' weights each class by n / (classes × count); used by logistic, boosting, MLP and SVM. */
  classWeight?: 'none' | 'balanced';
  /** Seconds before training stops (default 120). */
  timeLimitSec?: number;
}

export interface TrainedArtifact {
  format: 'aether-data-model';
  version: 1;
  createdAt: string;
  target: TargetSpec;
  preprocessor: Preprocessor;
  model: FittedModel;
  /** Input columns the model expects. */
  inputs: string[];
}

export interface ExperimentResult {
  config: ExperimentConfig;
  task: 'classification' | 'regression';
  rows: { train: number; test: number; dropped: number };
  metrics: Metrics;
  trainMetrics: Metrics;
  baseline: Metrics;
  primary: { name: string; value: number; baseline: number };
  cv?: { folds: number; scores: number[]; mean: number; std: number; metric: string };
  search?: { trials: { params: Record<string, unknown>; cvMean: number }[]; best: Record<string, unknown> };
  params: Record<string, unknown>;
  importance: { feature: string; value: number; method: 'permutation' }[];
  modelImportance?: { input: string; value: number }[];
  errors: ErrorAnalysis;
  roc?: { fpr: number[]; tpr: number[] };
  /** Training curve (loss per epoch / round) for models trained iteratively. */
  history?: import('./models.js').TrainHistory;
  leakage: LeakageFinding[];
  durationMs: number;
  artifact: TrainedArtifact;
}

export interface ErrorAnalysis {
  /** Worst test rows (largest absolute error, or confidently wrong). Row = index in the dataset version. */
  worst: { row: number; actual: Cell; predicted: Cell; error: number }[];
  /** Score per value of each categorical feature (top slices by size). */
  slices: { feature: string; value: string; n: number; score: number }[];
}

function sliceScore(task: 'classification' | 'regression', yt: number[], yp: number[]): number {
  if (task === 'classification') return yt.filter((v, i) => v === yp[i]).length / (yt.length || 1);
  return Math.sqrt(yt.reduce((a, v, i) => a + (v - yp[i]) ** 2, 0) / (yt.length || 1));
}

export function makeSplit(t: Table, rows: number[], cfg: SplitConfig, target: string): Split {
  const f = cfg.testFraction;
  switch (cfg.strategy) {
    case 'stratified': return stratifiedSplit(rows, getColumn(t, cfg.stratifyBy ?? target).values, f, cfg.seed);
    case 'group': if (!cfg.groupBy) throw new DataError('ml', 'Choose the group column.'); return groupSplit(rows, getColumn(t, cfg.groupBy).values, f, cfg.seed);
    case 'time': if (!cfg.timeColumn) throw new DataError('ml', 'Choose the time column.'); return timeSplit(rows, getColumn(t, cfg.timeColumn).values, f);
    default: return randomSplit(rows, f, cfg.seed);
  }
}

function evaluate(task: 'classification' | 'regression', m: FittedModel, X: number[][], y: number[], spec: TargetSpec): Metrics {
  if (task === 'regression') return regressionMetrics(y, predictLabels(m, X));
  const proba = predictRaw(m, X);
  return classificationMetrics(y, proba.map((p) => p.indexOf(Math.max(...p))), spec.classes!, proba);
}

async function trainOn(t: Table, cfg: ExperimentConfig, spec: TargetSpec, train: number[], params: Record<string, unknown>, ctx: TrainContext) {
  const pre = fitPreprocessor(t, cfg.features, train, { scale: cfg.scale });
  const X = transform(pre, t, train);
  const y = encodeTarget(spec, t, train);
  const model = await fitModel(cfg.model, spec.task, X, y, spec.classes?.length ?? 0, params, ctx, classWeights(cfg, spec, y));
  return { pre, model };
}

/** Per-row sample weights for 'balanced' class weighting (undefined = unweighted). */
export function classWeights(cfg: Pick<ExperimentConfig, 'classWeight'>, spec: TargetSpec, y: number[]): number[] | undefined {
  if (cfg.classWeight !== 'balanced' || spec.task !== 'classification') return undefined;
  const k = spec.classes!.length;
  const counts = new Array<number>(k).fill(0);
  for (const v of y) if (v >= 0) counts[v]++;
  const present = counts.filter((c) => c > 0).length || 1;
  const cw = counts.map((c) => (c ? y.length / (present * c) : 0));
  return y.map((v) => (v >= 0 ? cw[v] : 0));
}

async function cvScore(t: Table, cfg: ExperimentConfig, spec: TargetSpec, train: number[], params: Record<string, unknown>, k: number, ctx: TrainContext) {
  const folds = kFolds(train, k, cfg.split.seed, { labels: spec.task === 'classification' ? getColumn(t, spec.name).values : undefined, groups: cfg.split.groupBy ? getColumn(t, cfg.split.groupBy).values : undefined });
  const scores: number[] = [];
  let metric = '';
  for (const f of folds) {
    const { pre, model } = await trainOn(t, cfg, spec, f.train, params, ctx);
    const m = evaluate(spec.task, model, transform(pre, t, f.test), encodeTarget(spec, t, f.test), spec);
    const p = primaryScore(m);
    metric = p.name;
    scores.push(p.value);
  }
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const std = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, scores.length - 1));
  return { folds: k, scores, mean, std, metric };
}

export function searchTrials(space: Record<string, Array<number | string>>, method: 'grid' | 'random', maxTrials: number, seed: number): Record<string, unknown>[] {
  const keys = Object.keys(space).filter((k) => Array.isArray(space[k]) && space[k].length);
  let combos: Record<string, unknown>[] = [{}];
  for (const k of keys) combos = combos.flatMap((c) => space[k].slice(0, 20).map((v) => ({ ...c, [k]: v })));
  if (method === 'random' || combos.length > maxTrials) combos = shuffleInPlace(combos, mulberry32(seed));
  return combos.slice(0, maxTrials);
}

export async function runExperiment(t: Table, cfg: ExperimentConfig, opts: { signal?: AbortSignal; onProgress?: (p: number, stage: string) => void } = {}): Promise<ExperimentResult> {
  const started = Date.now();
  if (!cfg.features.length) throw new DataError('ml', 'Choose at least one feature.');
  if (cfg.features.includes(cfg.target)) throw new DataError('ml', 'The target cannot also be a feature.');
  if (!MODEL_INFO[cfg.model]) throw new DataError('ml', 'Unknown model.');
  for (const c of [cfg.target, ...cfg.features]) getColumn(t, c);
  const n = rowCount(t);
  if (n > ML_LIMITS.maxRows) throw new DataError('ml', `The built-in trainer handles up to ${ML_LIMITS.maxRows.toLocaleString('en')} rows. Sample the dataset first.`);
  const yAll = getColumn(t, cfg.target).values;
  const rows: number[] = [];
  for (let i = 0; i < n; i++) if (!isMissing(yAll[i])) rows.push(i);
  const dropped = n - rows.length;
  if (rows.length < 10) throw new DataError('ml', 'Need at least 10 rows with a target value.');
  const ctx = new TrainContext({ signal: opts.signal, deadline: started + Math.min(1800, Math.max(5, cfg.timeLimitSec ?? 120)) * 1000, onProgress: (p) => opts.onProgress?.(p, 'training') });
  const split = makeSplit(t, rows, cfg.split, cfg.target);
  const spec = fitTarget(t, cfg.target, cfg.task, split.train);
  let { train, test } = split;
  if (spec.task === 'regression') {
    train = train.filter((i) => !Number.isNaN(num(yAll[i])));
    test = test.filter((i) => !Number.isNaN(num(yAll[i])));
  } else {
    const known = new Set(spec.classes);
    test = test.filter((i) => known.has(String(yAll[i])));
  }
  if (!test.length) throw new DataError('ml', 'The test split is empty.');
  const leakage = leakageChecks(t, cfg.target, cfg.features, { train, test }, { groupBy: cfg.split.groupBy, timeColumn: cfg.split.timeColumn, task: spec.task });

  let params = clampParams(cfg.model, cfg.params ?? {});
  let search: ExperimentResult['search'];
  if (cfg.search && Object.keys(cfg.search.space).length) {
    opts.onProgress?.(0, 'search');
    const trials = searchTrials(cfg.search.space, cfg.search.method, Math.min(50, cfg.search.maxTrials ?? 20), cfg.split.seed);
    const results: { params: Record<string, unknown>; cvMean: number }[] = [];
    for (const tr of trials) {
      const p = clampParams(cfg.model, { ...cfg.params, ...tr });
      const s = await cvScore(t, cfg, spec, train, p, Math.max(2, Math.min(cfg.cvFolds || 3, 10)), ctx);
      results.push({ params: p, cvMean: s.mean });
    }
    results.sort((a, b) => b.cvMean - a.cvMean);
    params = results[0].params;
    search = { trials: results, best: params };
  }
  let cv: ExperimentResult['cv'];
  if (cfg.cvFolds && cfg.cvFolds >= 2) {
    opts.onProgress?.(0, 'cross-validation');
    cv = await cvScore(t, cfg, spec, train, params, Math.min(cfg.cvFolds, 20), ctx);
  }
  opts.onProgress?.(0, 'training');
  const { pre, model } = await trainOn(t, cfg, spec, train, params, ctx);
  const Xtest = transform(pre, t, test);
  const ytest = encodeTarget(spec, t, test);
  const metrics = evaluate(spec.task, model, Xtest, ytest, spec);
  const trainMetrics = evaluate(spec.task, model, transform(pre, t, train), encodeTarget(spec, t, train), spec);
  const ytrain = encodeTarget(spec, t, train);
  const baseModel = await fitModel('baseline', spec.task, transform(pre, t, train), ytrain, spec.classes?.length ?? 0, {});
  const baseline = evaluate(spec.task, baseModel, Xtest, ytest, spec);
  const p = primaryScore(metrics);
  const pb = primaryScore(baseline);

  // Permutation importance on the test rows, per original feature column.
  opts.onProgress?.(0, 'importance');
  const importance: ExperimentResult['importance'] = [];
  const rnd = mulberry32(cfg.split.seed + 1);
  const cols = new Map(cfg.features.map((f) => [f, getColumn(t, f).values] as const));
  const evalRows = test.length > 2000 ? shuffleInPlace(test.slice(), rnd).slice(0, 2000) : test;
  const yEval = encodeTarget(spec, t, evalRows);
  const scoreOf = (X: number[][]) => primaryScore(evaluate(spec.task, model, X, yEval, spec)).value;
  const ref = scoreOf(transform(pre, t, evalRows));
  for (const f of cfg.features) {
    const perm = shuffleInPlace(evalRows.slice(), rnd);
    const X = evalRows.map((i, k) => transformRow(pre, (name) => (name === f ? cols.get(f)![perm[k]] : cols.get(name)![i])));
    importance.push({ feature: f, value: ref - scoreOf(X), method: 'permutation' });
    await ctx.tick();
  }
  importance.sort((a, b) => b.value - a.value);

  // Error analysis.
  const raw = predictRaw(model, Xtest);
  const worst: ErrorAnalysis['worst'] = test.map((row, k) => {
    if (spec.task === 'regression') return { row, actual: yAll[row], predicted: raw[k][0], error: Math.abs(raw[k][0] - ytest[k]) };
    const pred = raw[k].indexOf(Math.max(...raw[k]));
    return { row, actual: yAll[row], predicted: spec.classes![pred], error: pred === ytest[k] ? 0 : raw[k][pred] };
  }).filter((w) => w.error > 0).sort((a, b) => b.error - a.error).slice(0, 25);
  const yp = spec.task === 'regression' ? raw.map((r) => r[0]) : raw.map((r) => r.indexOf(Math.max(...r)));
  const slices: ErrorAnalysis['slices'] = [];
  for (const f of pre.features) {
    if (f.kind !== 'categorical') continue;
    const vals = cols.get(f.name)!;
    const groups = new Map<string, number[]>();
    test.forEach((row, k) => { const v = isMissing(vals[row]) ? '(missing)' : String(vals[row]); (groups.get(v) ?? groups.set(v, []).get(v)!).push(k); });
    [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8).forEach(([value, ks]) => { if (ks.length >= 5) slices.push({ feature: f.name, value, n: ks.length, score: sliceScore(spec.task, ks.map((k) => ytest[k]), ks.map((k) => yp[k])) }); });
  }

  const artifact: TrainedArtifact = { format: 'aether-data-model', version: 1, createdAt: new Date().toISOString(), target: spec, preprocessor: pre, model, inputs: cfg.features.slice() };
  return {
    config: { ...cfg, params },
    task: spec.task,
    rows: { train: train.length, test: test.length, dropped },
    metrics,
    trainMetrics,
    baseline,
    primary: { name: p.name, value: p.value, baseline: pb.value },
    cv,
    search,
    params,
    importance,
    modelImportance: model.importance ? model.importance.map((v, i) => ({ input: pre.outputNames[i], value: v })).sort((a, b) => b.value - a.value).slice(0, 30) : undefined,
    errors: { worst, slices },
    roc: spec.task === 'classification' && spec.classes!.length === 2 ? rocCurve(ytest, raw.map((r) => r[1])) : undefined,
    history: model.history,
    leakage,
    durationMs: Date.now() - started,
    artifact,
  };
}

/** Predictions for new rows with a saved artifact (inference testing). */
export function predictWith(a: TrainedArtifact, rows: Array<Record<string, Cell>>): Array<{ prediction: Cell; proba?: Record<string, number> }> {
  const X = rows.map((r) => transformRow(a.preprocessor, (n) => (Object.prototype.hasOwnProperty.call(r, n) ? r[n] : null)));
  const raw = predictRaw(a.model, X);
  return raw.map((p) => {
    if (a.target.task === 'regression') return { prediction: p[0] };
    const k = p.indexOf(Math.max(...p));
    return { prediction: a.target.classes![k], proba: Object.fromEntries(a.target.classes!.map((c, i) => [c, p[i]])) };
  });
}
