/**
 * Epoch: AETHER's built-in ML engine, written in TypeScript with no native code.
 *
 * Models: majority/mean baseline, ridge and logistic regression, k-nearest
 * neighbours, Gaussian naive Bayes, CART decision tree, random forest,
 * gradient-boosted trees, multilayer perceptron and linear SVM (the last three
 * live in epoch-models.ts). It targets tabular and short-text data on a desktop
 * CPU; it is not a GPU deep-learning framework. Training yields to the event
 * loop regularly so the app stays responsive, honours cancellation and a time
 * limit.
 */
import { DataError } from '../table.js';
import { mulberry32, shuffleInPlace } from '../rng.js';
import { type GbmParams, type MlpParams, type SvmParams, fitGbm, fitMlp, fitSvm, predictGbm, predictMlp, predictSvm } from './epoch-models.js';

export type Task = 'classification' | 'regression';
export type ModelType = 'baseline' | 'linear' | 'logistic' | 'knn' | 'naiveBayes' | 'tree' | 'forest' | 'gbm' | 'mlp' | 'svm';

export interface ModelParams {
  baseline: Record<string, never>;
  linear: { l2: number };
  logistic: { l2: number; epochs: number; learningRate: number };
  knn: { k: number; weights: 'uniform' | 'distance' };
  naiveBayes: { varSmoothing: number };
  tree: { maxDepth: number; minSamplesLeaf: number };
  forest: { trees: number; maxDepth: number; minSamplesLeaf: number; maxFeatures: 'sqrt' | 'log2' | 'all'; seed: number };
  gbm: GbmParams;
  mlp: MlpParams;
  svm: SvmParams;
}

export const DEFAULT_PARAMS: { [K in ModelType]: ModelParams[K] } = {
  baseline: {},
  linear: { l2: 1e-3 },
  logistic: { l2: 1e-3, epochs: 300, learningRate: 0.05 },
  knn: { k: 5, weights: 'uniform' },
  naiveBayes: { varSmoothing: 1e-9 },
  tree: { maxDepth: 8, minSamplesLeaf: 5 },
  forest: { trees: 100, maxDepth: 10, minSamplesLeaf: 2, maxFeatures: 'sqrt', seed: 42 },
  gbm: { rounds: 200, learningRate: 0.1, maxDepth: 4, minSamplesLeaf: 10, l2: 1, subsample: 0.8, colsample: 1, earlyStopping: 20, seed: 42 },
  mlp: { hiddenLayers: '64,32', activation: 'relu', learningRate: 0.001, batchSize: 64, epochs: 200, l2: 1e-4, earlyStopping: 15, seed: 42 },
  svm: { C: 1, epochs: 30, learningRate: 0.1, seed: 42 },
};

export const MODEL_INFO: Record<ModelType, { title: string; tasks: Task[]; note: string }> = {
  baseline: { title: 'Baseline (majority class / mean)', tasks: ['classification', 'regression'], note: 'Predicts the most common class or the mean. Every real model should beat it.' },
  linear: { title: 'Linear regression (ridge)', tasks: ['regression'], note: 'Closed-form least squares with a small L2 penalty.' },
  logistic: { title: 'Logistic regression', tasks: ['classification'], note: 'Multinomial (softmax) with L2, trained by full-batch Adam.' },
  knn: { title: 'k-nearest neighbours', tasks: ['classification', 'regression'], note: 'Euclidean distance on scaled features; training sets over 20,000 rows are sub-sampled.' },
  naiveBayes: { title: 'Gaussian naive Bayes', tasks: ['classification'], note: 'Assumes independent, normally distributed features.' },
  tree: { title: 'Decision tree (CART)', tasks: ['classification', 'regression'], note: 'Gini / variance splits on up to 64 quantile thresholds per feature.' },
  forest: { title: 'Random forest', tasks: ['classification', 'regression'], note: 'Bagged CART trees with feature sub-sampling.' },
  gbm: { title: 'Gradient-boosted trees', tasks: ['classification', 'regression'], note: 'Second-order (XGBoost-style) histogram boosting with shrinkage, L2, row/column sub-sampling and early stopping on a 10% validation slice.' },
  mlp: { title: 'Neural network (MLP)', tasks: ['classification', 'regression'], note: 'Fully connected network trained by mini-batch Adam with L2 and early stopping. Hidden layers as a list, e.g. 64,32.' },
  svm: { title: 'Linear SVM', tasks: ['classification'], note: 'Hinge loss, one-vs-rest, trained by SGD. Scores are not calibrated probabilities.' },
};

/** Loss per epoch / boosting round, for the learning-curve chart. */
export interface TrainHistory { metric: string; train: number[]; val?: number[]; bestEpoch?: number }

export interface FittedModel {
  type: ModelType;
  task: Task;
  params: Record<string, unknown>;
  nInputs: number;
  nClasses: number;
  state: unknown;
  /** Impurity (trees) or |coefficient| (linear) importance per input, if the model has one. */
  importance?: number[];
  history?: TrainHistory;
}

export class TrainContext {
  private last = Date.now();
  constructor(private opts: { signal?: AbortSignal; deadline?: number; onProgress?: (p: number) => void } = {}) {}
  async tick(progress?: number): Promise<void> {
    const now = Date.now();
    if (now - this.last < 16) return;
    this.last = now;
    if (progress !== undefined) this.opts.onProgress?.(progress);
    await new Promise<void>((r) => setImmediate(r));
    if (this.opts.signal?.aborted) throw new DataError('cancelled', 'Training was cancelled.');
    if (this.opts.deadline && Date.now() > this.opts.deadline) throw new DataError('timeout', 'Training hit the time limit. Use fewer rows, fewer trees or a simpler model.');
  }
}

// ----------------------------------------------------------------------------- helpers

function softmax(z: number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((v) => Math.exp(v - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

/** Solves A x = b for symmetric positive-definite A (Cholesky), adding jitter if needed. */
export function solveSpd(A: number[][], b: number[]): number[] {
  const n = b.length;
  for (let attempt = 0; attempt < 6; attempt++) {
    const jitter = attempt === 0 ? 0 : 1e-10 * 10 ** (attempt * 2);
    const L = Array.from({ length: n }, () => new Float64Array(n));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i][j] + (i === j ? jitter : 0);
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) {
          if (s <= 0) { ok = false; break; }
          L[i][i] = Math.sqrt(s);
        } else L[i][j] = s / L[j][j];
      }
    }
    if (!ok) continue;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k]; x[i] = s / L[i][i]; }
    return Array.from(x);
  }
  throw new DataError('ml', 'The linear system is singular; remove duplicate or constant features.');
}

// ----------------------------------------------------------------------------- linear / logistic

async function fitLinear(X: number[][], y: number[], p: ModelParams['linear'], ctx: TrainContext): Promise<FittedModel> {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const mx = new Array(d).fill(0);
  let my = 0;
  for (let i = 0; i < n; i++) { for (let j = 0; j < d; j++) mx[j] += X[i][j] / n; my += y[i] / n; }
  const A = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const b = new Array<number>(d).fill(0);
  for (let i = 0; i < n; i++) {
    const r = X[i];
    const yc = y[i] - my;
    for (let j = 0; j < d; j++) {
      const xj = r[j] - mx[j];
      b[j] += xj * yc;
      for (let k = 0; k <= j; k++) A[j][k] += xj * (r[k] - mx[k]);
    }
    if (i % 2000 === 0) await ctx.tick(i / n);
  }
  for (let j = 0; j < d; j++) { for (let k = 0; k < j; k++) A[k][j] = A[j][k]; A[j][j] += p.l2 * n; }
  const w = d ? solveSpd(A, b) : [];
  const intercept = my - w.reduce((s, wj, j) => s + wj * mx[j], 0);
  return { type: 'linear', task: 'regression', params: p, nInputs: d, nClasses: 0, state: { w, intercept }, importance: w.map(Math.abs) };
}

async function fitLogistic(X: number[][], y: number[], k: number, p: ModelParams['logistic'], ctx: TrainContext, sw?: number[]): Promise<FittedModel> {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const W = Array.from({ length: k }, () => new Float64Array(d + 1));
  const m = Array.from({ length: k }, () => new Float64Array(d + 1));
  const v = Array.from({ length: k }, () => new Float64Array(d + 1));
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  const G = Array.from({ length: k }, () => new Float64Array(d + 1));
  let prevLoss = Infinity;
  const hist: number[] = [];
  const wsum = sw ? sw.reduce((a, b) => a + b, 0) : n;
  for (let epoch = 1; epoch <= p.epochs; epoch++) {
    for (const g of G) g.fill(0);
    let loss = 0;
    for (let i = 0; i < n; i++) {
      const x = X[i];
      const z = W.map((w) => { let s = w[d]; for (let j = 0; j < d; j++) s += w[j] * x[j]; return s; });
      const pr = softmax(z);
      const wi = sw ? sw[i] : 1;
      loss -= wi * Math.log(Math.max(1e-15, pr[y[i]]));
      for (let c = 0; c < k; c++) {
        const e = wi * (pr[c] - (y[i] === c ? 1 : 0));
        const g = G[c];
        for (let j = 0; j < d; j++) g[j] += e * x[j];
        g[d] += e;
      }
    }
    loss /= wsum;
    hist.push(loss);
    for (let c = 0; c < k; c++) {
      for (let j = 0; j <= d; j++) {
        const g = G[c][j] / wsum + (j < d ? p.l2 * W[c][j] : 0);
        m[c][j] = b1 * m[c][j] + (1 - b1) * g;
        v[c][j] = b2 * v[c][j] + (1 - b2) * g * g;
        const mh = m[c][j] / (1 - b1 ** epoch);
        const vh = v[c][j] / (1 - b2 ** epoch);
        W[c][j] -= (p.learningRate * mh) / (Math.sqrt(vh) + eps);
      }
    }
    await ctx.tick(epoch / p.epochs);
    if (Math.abs(prevLoss - loss) < 1e-7) break;
    prevLoss = loss;
  }
  const weights = W.map((w) => Array.from(w));
  const importance = Array.from({ length: d }, (_, j) => weights.reduce((s, w) => s + Math.abs(w[j]), 0) / k);
  return { type: 'logistic', task: 'classification', params: p, nInputs: d, nClasses: k, state: { weights }, importance, history: { metric: 'log loss', train: hist } };
}

// ----------------------------------------------------------------------------- kNN / naive Bayes

const KNN_MAX_TRAIN = 20_000;

function fitKnn(X: number[][], y: number[], task: Task, k: number, p: ModelParams['knn']): FittedModel {
  let Xs = X;
  let ys = y;
  // Bound the stored training copy to ~2M numbers so saved models stay small.
  const cap = Math.max(100, Math.min(KNN_MAX_TRAIN, Math.floor(2_000_000 / Math.max(1, X[0]?.length ?? 1))));
  if (X.length > cap) {
    const idx = shuffleInPlace(X.map((_, i) => i), mulberry32(7)).slice(0, cap);
    Xs = idx.map((i) => X[i]);
    ys = idx.map((i) => y[i]);
  }
  return { type: 'knn', task, params: p, nInputs: X[0]?.length ?? 0, nClasses: k, state: { X: Xs, y: ys } };
}

function fitNaiveBayes(X: number[][], y: number[], k: number, p: ModelParams['naiveBayes']): FittedModel {
  const d = X[0]?.length ?? 0;
  const count = new Array(k).fill(0);
  const mu = Array.from({ length: k }, () => new Array<number>(d).fill(0));
  const va = Array.from({ length: k }, () => new Array<number>(d).fill(0));
  X.forEach((x, i) => { count[y[i]]++; for (let j = 0; j < d; j++) mu[y[i]][j] += x[j]; });
  for (let c = 0; c < k; c++) for (let j = 0; j < d; j++) mu[c][j] /= count[c] || 1;
  X.forEach((x, i) => { for (let j = 0; j < d; j++) va[y[i]][j] += (x[j] - mu[y[i]][j]) ** 2; });
  let maxVar = 0;
  for (let j = 0; j < d; j++) { let m = 0; X.forEach((x) => (m += x[j])); m /= X.length; let s = 0; X.forEach((x) => (s += (x[j] - m) ** 2)); maxVar = Math.max(maxVar, s / X.length); }
  const eps = p.varSmoothing * (maxVar || 1);
  for (let c = 0; c < k; c++) for (let j = 0; j < d; j++) va[c][j] = va[c][j] / (count[c] || 1) + eps;
  const prior = count.map((c) => Math.log((c + 1e-9) / X.length));
  return { type: 'naiveBayes', task: 'classification', params: p, nInputs: d, nClasses: k, state: { mu, va, prior } };
}

// ----------------------------------------------------------------------------- trees (histogram CART)

const MAX_BINS = 64;

interface TreeNode {
  /** Feature index, or -1 for a leaf. */
  f: number;
  t: number;
  l: number;
  r: number;
  /** Leaf value: class probabilities or the mean. */
  v: number[];
}

interface Binned {
  thresholds: number[][];
  bins: Uint8Array[];
}

export function binFeatures(X: number[][]): Binned {
  const d = X[0]?.length ?? 0;
  const n = X.length;
  const thresholds: number[][] = [];
  const bins: Uint8Array[] = [];
  for (let j = 0; j < d; j++) {
    const col = Float64Array.from(X, (r) => r[j]).sort();
    const th: number[] = [];
    const uniq: number[] = [];
    for (let i = 0; i < n; i++) if (i === 0 || col[i] !== col[i - 1]) uniq.push(col[i]);
    if (uniq.length <= MAX_BINS) for (let i = 0; i + 1 < uniq.length; i++) th.push((uniq[i] + uniq[i + 1]) / 2);
    else {
      for (let b = 1; b < MAX_BINS; b++) {
        const q = col[Math.floor((b / MAX_BINS) * (n - 1))];
        if (th.length === 0 || q > th[th.length - 1]) th.push(q);
      }
    }
    thresholds.push(th);
    const bj = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const x = X[i][j];
      let lo = 0, hi = th.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (x <= th[mid]) hi = mid; else lo = mid + 1; }
      bj[i] = lo;
    }
    bins.push(bj);
  }
  return { thresholds, bins };
}

async function growTree(B: Binned, y: number[], rows: number[], task: Task, k: number, p: { maxDepth: number; minSamplesLeaf: number }, featureCount: number, rnd: () => number, ctx: TrainContext, importance: number[]): Promise<TreeNode[]> {
  const nodes: TreeNode[] = [];
  const d = B.bins.length;
  const leafValue = (idx: number[]): number[] => {
    if (task === 'regression') { let s = 0; for (const i of idx) s += y[i]; return [s / (idx.length || 1)]; }
    const c = new Array(k).fill(0);
    for (const i of idx) c[y[i]]++;
    return c.map((x) => x / (idx.length || 1));
  };
  const impurity = (counts: number[], n: number, s?: number, ss?: number): number => {
    if (task === 'regression') return n ? ss! / n - (s! / n) ** 2 : 0;
    let g = 1;
    for (const c of counts) g -= (c / n) ** 2;
    return n ? g : 0;
  };
  const build = async (idx: number[], depth: number): Promise<number> => {
    const id = nodes.length;
    nodes.push({ f: -1, t: 0, l: -1, r: -1, v: leafValue(idx) });
    await ctx.tick();
    if (depth >= p.maxDepth || idx.length < 2 * p.minSamplesLeaf) return id;
    const n = idx.length;
    let parentCounts: number[] = [];
    let ps = 0, pss = 0;
    if (task === 'regression') for (const i of idx) { ps += y[i]; pss += y[i] * y[i]; }
    else { parentCounts = new Array(k).fill(0); for (const i of idx) parentCounts[y[i]]++; }
    const parentImp = impurity(parentCounts, n, ps, pss);
    if (parentImp <= 1e-12) return id;
    let feats = Array.from({ length: d }, (_, j) => j);
    if (featureCount < d) feats = shuffleInPlace(feats, rnd).slice(0, featureCount);
    let best = { gain: 1e-12, f: -1, bin: -1 };
    for (const f of feats) {
      const th = B.thresholds[f];
      if (!th.length) continue;
      const nb = th.length + 1;
      const bf = B.bins[f];
      const cnt = new Float64Array(nb);
      const sum = new Float64Array(nb);
      const sq = new Float64Array(nb);
      const cls = task === 'classification' ? new Float64Array(nb * k) : null;
      for (const i of idx) {
        const b = bf[i];
        cnt[b]++;
        if (cls) cls[b * k + y[i]]++;
        else { sum[b] += y[i]; sq[b] += y[i] * y[i]; }
      }
      let ln = 0, ls = 0, lss = 0;
      const lc = new Array(k).fill(0);
      for (let b = 0; b < nb - 1; b++) {
        ln += cnt[b];
        if (cls) for (let c = 0; c < k; c++) lc[c] += cls[b * k + c];
        else { ls += sum[b]; lss += sq[b]; }
        const rn = n - ln;
        if (ln < p.minSamplesLeaf || rn < p.minSamplesLeaf) continue;
        const li = cls ? impurity(lc, ln) : impurity([], ln, ls, lss);
        const ri = cls ? impurity(parentCounts.map((c, j) => c - lc[j]), rn) : impurity([], rn, ps - ls, pss - lss);
        const gain = parentImp - (ln / n) * li - (rn / n) * ri;
        if (gain > best.gain) best = { gain, f, bin: b };
      }
    }
    if (best.f < 0) return id;
    const bf = B.bins[best.f];
    const left: number[] = [];
    const right: number[] = [];
    for (const i of idx) (bf[i] <= best.bin ? left : right).push(i);
    importance[best.f] += best.gain * n;
    nodes[id].f = best.f;
    nodes[id].t = B.thresholds[best.f][best.bin];
    nodes[id].l = await build(left, depth + 1);
    nodes[id].r = await build(right, depth + 1);
    return id;
  };
  await build(rows, 0);
  return nodes;
}

function treePredict(nodes: TreeNode[], x: number[]): number[] {
  let i = 0;
  while (nodes[i].f >= 0) i = x[nodes[i].f] <= nodes[i].t ? nodes[i].l : nodes[i].r;
  return nodes[i].v;
}

function normalise(v: number[]): number[] {
  const s = v.reduce((a, b) => a + b, 0) || 1;
  return v.map((x) => x / s);
}

// ----------------------------------------------------------------------------- public API

export function clampParams(type: ModelType, raw: Record<string, unknown> = {}): Record<string, unknown> {
  const d = DEFAULT_PARAMS[type] as Record<string, unknown>;
  const n = (k: string, lo: number, hi: number, int = false) => { const v = typeof raw[k] === 'number' && Number.isFinite(raw[k]) ? (raw[k] as number) : (d[k] as number); const c = Math.min(hi, Math.max(lo, v)); return int ? Math.round(c) : c; };
  switch (type) {
    case 'baseline': return {};
    case 'linear': return { l2: n('l2', 0, 1e6) };
    case 'logistic': return { l2: n('l2', 0, 100), epochs: n('epochs', 1, 5000, true), learningRate: n('learningRate', 1e-5, 1) };
    case 'knn': return { k: n('k', 1, 200, true), weights: raw.weights === 'distance' ? 'distance' : 'uniform' };
    case 'naiveBayes': return { varSmoothing: n('varSmoothing', 0, 1) };
    case 'tree': return { maxDepth: n('maxDepth', 1, 30, true), minSamplesLeaf: n('minSamplesLeaf', 1, 10_000, true) };
    case 'forest': return { trees: n('trees', 1, 500, true), maxDepth: n('maxDepth', 1, 30, true), minSamplesLeaf: n('minSamplesLeaf', 1, 10_000, true), maxFeatures: ['sqrt', 'log2', 'all'].includes(raw.maxFeatures as string) ? raw.maxFeatures : d.maxFeatures, seed: n('seed', 0, 2 ** 31 - 1, true) };
    case 'gbm': return { rounds: n('rounds', 1, 5000, true), learningRate: n('learningRate', 1e-4, 1), maxDepth: n('maxDepth', 1, 12, true), minSamplesLeaf: n('minSamplesLeaf', 1, 10_000, true), l2: n('l2', 0, 1000), subsample: n('subsample', 0.1, 1), colsample: n('colsample', 0.1, 1), earlyStopping: n('earlyStopping', 0, 500, true), seed: n('seed', 0, 2 ** 31 - 1, true) };
    case 'mlp': return { hiddenLayers: typeof raw.hiddenLayers === 'string' && /^\s*\d{1,4}(\s*,\s*\d{1,4}){0,4}\s*$/.test(raw.hiddenLayers) ? raw.hiddenLayers.replace(/\s+/g, '') : d.hiddenLayers, activation: raw.activation === 'tanh' ? 'tanh' : 'relu', learningRate: n('learningRate', 1e-5, 1), batchSize: n('batchSize', 1, 4096, true), epochs: n('epochs', 1, 2000, true), l2: n('l2', 0, 10), earlyStopping: n('earlyStopping', 0, 500, true), seed: n('seed', 0, 2 ** 31 - 1, true) };
    case 'svm': return { C: n('C', 1e-4, 1e4), epochs: n('epochs', 1, 1000, true), learningRate: n('learningRate', 1e-5, 10), seed: n('seed', 0, 2 ** 31 - 1, true) };
  }
}

export async function fitModel(type: ModelType, task: Task, X: number[][], y: number[], nClasses: number, rawParams: Record<string, unknown>, ctx = new TrainContext(), sampleWeights?: number[]): Promise<FittedModel> {
  if (!MODEL_INFO[type]) throw new DataError('ml', `Unknown model ${type}.`);
  if (!MODEL_INFO[type].tasks.includes(task)) throw new DataError('ml', `${MODEL_INFO[type].title} does not do ${task}.`);
  if (X.length < 2) throw new DataError('ml', 'Need at least two training rows.');
  const params = clampParams(type, rawParams);
  const d = X[0].length;
  const sw = sampleWeights && sampleWeights.length === X.length ? sampleWeights : undefined;
  switch (type) {
    case 'baseline': {
      if (task === 'regression') return { type, task, params, nInputs: d, nClasses: 0, state: { mean: y.reduce((a, b) => a + b, 0) / y.length } };
      const c = new Array(nClasses).fill(0);
      y.forEach((v) => c[v]++);
      return { type, task, params, nInputs: d, nClasses, state: { proba: normalise(c) } };
    }
    case 'linear': return fitLinear(X, y, params as ModelParams['linear'], ctx);
    case 'logistic': return fitLogistic(X, y, nClasses, params as ModelParams['logistic'], ctx, sw);
    case 'knn': return fitKnn(X, y, task, nClasses, params as ModelParams['knn']);
    case 'naiveBayes': return fitNaiveBayes(X, y, nClasses, params as ModelParams['naiveBayes']);
    case 'tree': {
      const B = binFeatures(X);
      const imp = new Array(d).fill(0);
      const nodes = await growTree(B, y, X.map((_, i) => i), task, nClasses, params as ModelParams['tree'], d, mulberry32(1), ctx, imp);
      return { type, task, params, nInputs: d, nClasses, state: { nodes }, importance: normalise(imp) };
    }
    case 'forest': {
      const p = params as ModelParams['forest'];
      const B = binFeatures(X);
      const rnd = mulberry32(p.seed);
      const mf = p.maxFeatures === 'all' ? d : Math.max(1, Math.round(p.maxFeatures === 'sqrt' ? Math.sqrt(d) : Math.log2(d)));
      const imp = new Array(d).fill(0);
      const trees: TreeNode[][] = [];
      for (let t = 0; t < p.trees; t++) {
        const rows = Array.from({ length: X.length }, () => Math.floor(rnd() * X.length));
        trees.push(await growTree(B, y, rows, task, nClasses, p, mf, rnd, ctx, imp));
        await ctx.tick((t + 1) / p.trees);
      }
      return { type, task, params, nInputs: d, nClasses, state: { trees }, importance: normalise(imp) };
    }
    case 'gbm': return fitGbm(X, y, task, nClasses, params as unknown as GbmParams, ctx, sw);
    case 'mlp': return fitMlp(X, y, task, nClasses, params as unknown as MlpParams, ctx, sw);
    case 'svm': return fitSvm(X, y, nClasses, params as unknown as SvmParams, ctx, sw);
  }
}

/** Class probabilities (classification) or [value] (regression) per row. */
export function predictRaw(m: FittedModel, X: number[][]): number[][] {
  const s = m.state as Record<string, unknown>;
  for (const x of X) if (x.length !== m.nInputs) throw new DataError('ml', `Expected ${m.nInputs} inputs, got ${x.length}.`);
  switch (m.type) {
    case 'baseline': return X.map(() => (m.task === 'regression' ? [s.mean as number] : (s.proba as number[])));
    case 'linear': { const w = s.w as number[]; const b = s.intercept as number; return X.map((x) => [x.reduce((a, xj, j) => a + xj * w[j], b)]); }
    case 'logistic': { const W = s.weights as number[][]; const d = m.nInputs; return X.map((x) => softmax(W.map((w) => { let z = w[d]; for (let j = 0; j < d; j++) z += w[j] * x[j]; return z; }))); }
    case 'knn': {
      const TX = s.X as number[][];
      const ty = s.y as number[];
      const p = m.params as ModelParams['knn'];
      const k = Math.min(p.k, TX.length);
      return X.map((x) => {
        const dist = TX.map((t, i) => { let d2 = 0; for (let j = 0; j < x.length; j++) d2 += (t[j] - x[j]) ** 2; return [d2, i] as const; });
        dist.sort((a, b) => a[0] - b[0]);
        const near = dist.slice(0, k);
        const w = near.map(([d2]) => (p.weights === 'distance' ? 1 / (Math.sqrt(d2) + 1e-9) : 1));
        if (m.task === 'regression') return [near.reduce((a, [, i], j) => a + ty[i] * w[j], 0) / w.reduce((a, b) => a + b, 0)];
        const votes = new Array(m.nClasses).fill(0);
        near.forEach(([, i], j) => (votes[ty[i]] += w[j]));
        return normalise(votes);
      });
    }
    case 'naiveBayes': {
      const mu = s.mu as number[][];
      const va = s.va as number[][];
      const prior = s.prior as number[];
      return X.map((x) => softmax(prior.map((pr, c) => { let l = pr; for (let j = 0; j < x.length; j++) l -= 0.5 * (Math.log(2 * Math.PI * va[c][j]) + (x[j] - mu[c][j]) ** 2 / va[c][j]); return l; })));
    }
    case 'tree': return X.map((x) => treePredict(s.nodes as TreeNode[], x));
    case 'forest': {
      const trees = s.trees as TreeNode[][];
      return X.map((x) => {
        const acc = new Array(m.task === 'regression' ? 1 : m.nClasses).fill(0);
        for (const t of trees) treePredict(t, x).forEach((v, i) => (acc[i] += v / trees.length));
        return acc;
      });
    }
    case 'gbm': return predictGbm(m, X);
    case 'mlp': return predictMlp(m, X);
    case 'svm': return predictSvm(m, X);
  }
}

export function predictLabels(m: FittedModel, X: number[][]): number[] {
  return predictRaw(m, X).map((p) => (m.task === 'regression' ? p[0] : p.indexOf(Math.max(...p))));
}

/** Rough size of the stored model, for limits and display. */
export function modelBytes(m: FittedModel): number {
  return JSON.stringify(m.state).length;
}
