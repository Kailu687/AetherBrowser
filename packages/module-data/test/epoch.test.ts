import { describe, expect, it } from 'vitest';
import { classWeights, predictWith, runExperiment } from '../src/ml/experiment.js';
import { validateArtifact } from '../src/ml/artifact.js';
import { clampParams, fitModel, predictLabels, TrainContext, type ModelType } from '../src/ml/models.js';
import { kMeans, pca, standardise, symmetricEigen } from '../src/ml/unsupervised.js';
import { runToSklearn } from '../src/ml/sklearn.js';
import { fitPreprocessor, tokenize, transform } from '../src/ml/features.js';
import { applyStep, pipelineToPandas, validateSteps } from '../src/pipeline.js';
import { mulberry32, gaussian } from '../src/rng.js';
import type { Table } from '../src/table.js';
import { synthClassification, synthRegression } from './helpers.js';

const split = { strategy: 'stratified' as const, testFraction: 0.25, seed: 7 };
const fast: Record<string, Record<string, unknown>> = { gbm: { rounds: 60 }, mlp: { epochs: 60, hiddenLayers: '16' }, svm: { epochs: 20 } };

/** Three classes on a ring: not linearly separable from one side. */
function threeClass(n = 600, seed = 5): Table {
  const r = mulberry32(seed);
  const a: number[] = [], b: number[] = [], lab: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = i % 3;
    const ang = (k * 2 * Math.PI) / 3;
    a.push(Math.cos(ang) * 3 + gaussian(r) * 0.6);
    b.push(Math.sin(ang) * 3 + gaussian(r) * 0.6);
    lab.push(['alpha', 'beta', 'gamma'][k]);
  }
  return { columns: [{ name: 'a', values: a }, { name: 'b', values: b }, { name: 'cls', values: lab }] };
}

describe('Epoch: new model families', () => {
  const t = synthClassification();
  for (const model of ['gbm', 'mlp', 'svm'] as ModelType[]) {
    it(`${model} learns a binary task and beats the baseline`, async () => {
      const r = await runExperiment(t, { target: 'label', features: ['x', 'y', 'colour'], task: 'auto', model, params: fast[model], split });
      expect(r.metrics.task === 'classification' && r.metrics.accuracy).toBeGreaterThan(0.85);
      expect(r.primary.value).toBeGreaterThan(r.primary.baseline + 0.2);
      expect(r.history?.train.length).toBeGreaterThan(1);
      expect(() => validateArtifact(JSON.parse(JSON.stringify(r.artifact)))).not.toThrow();
    });
  }
  for (const model of ['gbm', 'mlp', 'svm'] as ModelType[]) {
    it(`${model} handles three classes`, async () => {
      const r = await runExperiment(threeClass(), { target: 'cls', features: ['a', 'b'], task: 'classification', model, params: fast[model], split });
      expect(r.metrics.task === 'classification' && r.metrics.accuracy).toBeGreaterThan(0.9);
      const p = predictWith(r.artifact, [{ a: 3, b: 0 }, { a: -1.5, b: 2.6 }]);
      expect(p.map((x) => x.prediction)).toEqual(['alpha', 'beta']);
      expect(() => validateArtifact(JSON.parse(JSON.stringify(r.artifact)))).not.toThrow();
    });
  }
  for (const model of ['gbm', 'mlp'] as ModelType[]) {
    it(`${model} does regression`, async () => {
      const r = await runExperiment(synthRegression(), { target: 'target', features: ['x', 'junk'], task: 'regression', model, params: fast[model], split: { strategy: 'random', testFraction: 0.25, seed: 1 } });
      expect(r.metrics.task === 'regression' && r.metrics.r2).toBeGreaterThan(0.95);
      expect(() => validateArtifact(JSON.parse(JSON.stringify(r.artifact)))).not.toThrow();
    });
  }
  it('gradient boosting fits a non-linear (XOR) pattern a linear model cannot', async () => {
    const r = mulberry32(9);
    const x1: number[] = [], x2: number[] = [], y: string[] = [];
    for (let i = 0; i < 800; i++) { const a = r() * 2 - 1, b = r() * 2 - 1; x1.push(a); x2.push(b); y.push(a * b > 0 ? 'same' : 'diff'); }
    const xor: Table = { columns: [{ name: 'x1', values: x1 }, { name: 'x2', values: x2 }, { name: 'y', values: y }] };
    const g = await runExperiment(xor, { target: 'y', features: ['x1', 'x2'], task: 'classification', model: 'gbm', params: { rounds: 100 }, split });
    const l = await runExperiment(xor, { target: 'y', features: ['x1', 'x2'], task: 'classification', model: 'logistic', split });
    expect(g.metrics.task === 'classification' && g.metrics.accuracy).toBeGreaterThan(0.9);
    expect(l.metrics.task === 'classification' && l.metrics.accuracy).toBeLessThan(0.7);
  });
  it('early stopping keeps the best round and records validation loss', async () => {
    const r = await runExperiment(t, { target: 'label', features: ['x', 'y', 'colour'], task: 'classification', model: 'gbm', params: { rounds: 400, learningRate: 0.3, earlyStopping: 5 }, split });
    expect(r.history!.val!.length).toBeGreaterThan(1);
    expect(r.history!.bestEpoch).toBeLessThan(400);
  });
  it('is reproducible from the seed', async () => {
    for (const model of ['gbm', 'mlp', 'svm'] as ModelType[]) {
      const cfg = { target: 'label', features: ['x', 'y'], task: 'classification' as const, model, params: { ...fast[model], seed: 3 }, split };
      const a = await runExperiment(t, cfg);
      const b = await runExperiment(t, cfg);
      expect(a.metrics).toEqual(b.metrics);
    }
  });
  it('clamps hostile parameters', () => {
    expect(clampParams('mlp', { hiddenLayers: '99999,1;rm -rf', epochs: 1e9, learningRate: -1 })).toMatchObject({ hiddenLayers: '64,32', epochs: 2000, learningRate: 1e-5 });
    expect(clampParams('gbm', { rounds: 1e9, maxDepth: 100, subsample: 0 })).toMatchObject({ rounds: 5000, maxDepth: 12, subsample: 0.1 });
    expect(clampParams('svm', { C: Infinity })).toMatchObject({ C: 1 });
  });
  it('honours cancellation', async () => {
    const ac = new AbortController();
    ac.abort();
    const X = Array.from({ length: 300 }, (_, i) => [i % 7, i % 5]);
    const y = X.map((x) => (x[0] > 3 ? 1 : 0));
    await new Promise((r) => setTimeout(r, 20));
    await expect(fitModel('mlp', 'classification', X, y, 2, { epochs: 500 }, new TrainContext({ signal: ac.signal }))).rejects.toThrow(/cancelled/);
  });
});

describe('Epoch: class weights and text features', () => {
  it('balanced weights raise minority-class recall', async () => {
    const r = mulberry32(4);
    const x: number[] = [], y: string[] = [];
    for (let i = 0; i < 1000; i++) { const rare = r() < 0.08; x.push((rare ? 1.2 : 0) + gaussian(r)); y.push(rare ? 'rare' : 'common'); }
    const tb: Table = { columns: [{ name: 'x', values: x }, { name: 'y', values: y }] };
    const base = { target: 'y', features: ['x'], task: 'classification' as const, model: 'logistic' as const, split };
    const plain = await runExperiment(tb, base);
    const bal = await runExperiment(tb, { ...base, classWeight: 'balanced' });
    const recall = (m: typeof plain.metrics) => (m.task === 'classification' ? m.perClass.find((c) => c.label === 'rare')!.recall : 0);
    expect(recall(bal.metrics)).toBeGreaterThan(recall(plain.metrics) + 0.2);
  });
  it('computes n / (k × count) weights', () => {
    const w = classWeights({ classWeight: 'balanced' }, { name: 'y', task: 'classification', classes: ['a', 'b'] }, [0, 0, 0, 1]);
    expect(w).toEqual([4 / 6, 4 / 6, 4 / 6, 2]);
    expect(classWeights({ classWeight: 'none' }, { name: 'y', task: 'classification', classes: ['a', 'b'] }, [0, 1])).toBeUndefined();
  });
  it('tokenizes Unicode text and caps tokens', () => {
    expect(tokenize('Great phone, BAD battery — बैटरी खराब!')).toEqual(['great', 'phone', 'bad', 'battery', 'बैटरी', 'खराब']);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize('ab '.repeat(5000))).toHaveLength(2000);
  });
  it('learns from a free-text column (TF-IDF)', async () => {
    const r = mulberry32(8);
    const good = ['great', 'excellent', 'love', 'perfect', 'happy'];
    const bad = ['awful', 'broken', 'refund', 'terrible', 'slow'];
    const filler = ['the', 'phone', 'arrived', 'today', 'and', 'it', 'is', 'really', 'quite', 'honestly'];
    const text: string[] = [], y: string[] = [];
    for (let i = 0; i < 600; i++) {
      const pos = r() < 0.5;
      const words = Array.from({ length: 6 }, () => filler[Math.floor(r() * filler.length)]);
      words.splice(Math.floor(r() * 6), 0, (pos ? good : bad)[Math.floor(r() * 5)]);
      text.push(words.join(' ') + ` order ${i} with extra words to look like prose`);
      y.push(pos ? 'pos' : 'neg');
    }
    const tb: Table = { columns: [{ name: 'review', values: text }, { name: 'sentiment', values: y }] };
    const res = await runExperiment(tb, { target: 'sentiment', features: ['review'], task: 'classification', model: 'logistic', split });
    expect(res.artifact.preprocessor.features[0].kind).toBe('text');
    expect(res.metrics.task === 'classification' && res.metrics.accuracy).toBeGreaterThan(0.95);
    expect(predictWith(res.artifact, [{ review: 'I love it, perfect' }, { review: 'broken, I want a refund' }]).map((p) => p.prediction)).toEqual(['pos', 'neg']);
    expect(() => validateArtifact(JSON.parse(JSON.stringify(res.artifact)))).not.toThrow();
  });
  it('fits the vocabulary on training rows only', () => {
    const tb: Table = { columns: [{ name: 's', values: ['alpha beta gamma delta', 'alpha beta gamma delta', 'zeta eta theta iota', 'zeta eta theta iota', 'secret word here now'] }] };
    const pre = fitPreprocessor(tb, ['s'], [0, 1, 2, 3]);
    expect(pre.outputNames.some((n) => n.includes('secret'))).toBe(false);
    const X = transform(pre, tb, [4]);
    expect(X[0].every((v) => v === 0)).toBe(true);
  });
});

describe('Epoch: imported model files are validated', () => {
  it('rejects tampered boosting, network and SVM files', async () => {
    const t = synthClassification(300);
    for (const model of ['gbm', 'mlp', 'svm'] as ModelType[]) {
      const r = await runExperiment(t, { target: 'label', features: ['x', 'y'], task: 'classification', model, params: fast[model], split });
      const art = JSON.parse(JSON.stringify(r.artifact));
      const s = art.model.state;
      if (model === 'gbm') s.trees[0][0] = { f: 0, t: 0, l: 0, r: 0, v: [0] }; // child loops to itself
      if (model === 'mlp') s.layers[0].W.length = 3;
      if (model === 'svm') s.weights[0][0] = 'x';
      expect(() => validateArtifact(art)).toThrow(/Not a valid AETHER model file/);
    }
  });
  it('rejects an oversized text vocabulary and non-finite idf', () => {
    const base = { format: 'aether-data-model', version: 1, target: { name: 'y', task: 'regression' }, inputs: ['s'], model: { type: 'baseline', task: 'regression', nInputs: 1, nClasses: 0, params: {}, state: { mean: 0 } } };
    expect(() => validateArtifact({ ...base, preprocessor: { scale: true, outputNames: ['s~a'], features: [{ name: 's', kind: 'text', vocab: ['a'], idf: [Infinity] }] } })).toThrow();
    const vocab = Array.from({ length: 600 }, (_, i) => `w${i}`);
    expect(() => validateArtifact({ ...base, model: { ...base.model, nInputs: 600 }, preprocessor: { scale: true, outputNames: vocab, features: [{ name: 's', kind: 'text', vocab, idf: vocab.map(() => 1) }] } })).toThrow();
  });
  it('predicts with a hand-checked boosted model', () => {
    const m = { type: 'gbm' as const, task: 'regression' as const, params: {}, nInputs: 1, nClasses: 0, state: { base: [1], outputs: 1, trees: [[{ f: 0, t: 0.5, l: 1, r: 2, v: [0] }, { f: -1, t: 0, l: -1, r: -1, v: [-1] }, { f: -1, t: 0, l: -1, r: -1, v: [2] }]] } };
    expect(predictLabels(m, [[0], [1]])).toEqual([0, 3]);
  });
});

describe('Epoch: clustering, PCA and scikit-learn export', () => {
  it('k-means finds well-separated clusters, deterministically', () => {
    const r = mulberry32(2);
    const X = Array.from({ length: 300 }, (_, i) => { const c = i % 3; return [c * 10 + gaussian(r), -c * 10 + gaussian(r)]; });
    const a = kMeans(X, 3, 42);
    const b = kMeans(X, 3, 42);
    expect(a.labels).toEqual(b.labels);
    for (let c = 0; c < 3; c++) expect(new Set(X.map((_, i) => i).filter((i) => i % 3 === c).map((i) => a.labels[i])).size).toBe(1);
    expect(() => kMeans(X, 1, 1)).toThrow();
  });
  it('PCA recovers the main axis and explains the variance', () => {
    const r = mulberry32(3);
    const X = Array.from({ length: 500 }, () => { const s = gaussian(r); return [s, s + 0.05 * gaussian(r), gaussian(r)]; });
    const z = standardise([X.map((x) => x[0]), X.map((x) => x[1]), X.map((x) => x[2])]);
    const p = pca(z.X, 2);
    expect(p.explained[0]).toBeGreaterThan(0.6);
    expect(Math.abs(p.loadings[0][2])).toBeLessThan(0.1);
    const e = symmetricEigen([[2, 1], [1, 2]]);
    expect(e.values[0]).toBeCloseTo(3);
    expect(e.values[1]).toBeCloseTo(1);
  });
  it('pipeline steps add cluster and PC columns and validate input', () => {
    const t = synthClassification(200);
    const steps = validateSteps([{ op: 'kmeans', columns: ['x', 'y'], k: 4, seed: 1 }, { op: 'pca', columns: ['x', 'y'], components: 9 }]);
    expect(steps[1]).toMatchObject({ components: 2 });
    let cur = applyStep(t, steps[0]).table;
    expect(cur.columns.at(-1)!.name).toBe('cluster');
    expect(new Set(cur.columns.at(-1)!.values).size).toBe(4);
    cur = applyStep(cur, steps[1]).table;
    expect(cur.columns.slice(-2).map((c) => c.name)).toEqual(['PC1', 'PC2']);
    expect(() => validateSteps([{ op: 'kmeans', columns: 'x' }])).toThrow();
    expect(pipelineToPandas(steps)).toContain('KMeans(n_clusters=4');
  });
  it('writes a scikit-learn script for a run with safe string quoting', async () => {
    const t = synthClassification(200);
    const r = await runExperiment(t, { target: 'label', features: ['x', 'colour'], task: 'classification', model: 'gbm', params: { rounds: 20 }, split, classWeight: 'balanced' });
    const py = runToSklearn(r.config, r.artifact, { path: 'my "data".csv', format: 'csv', steps: [] });
    expect(py).toContain('HistGradientBoostingClassifier(max_iter=20');
    expect(py).toContain('class_weight="balanced"');
    expect(py).toContain('stratify=y');
    expect(py).toContain('numeric = ["x"]');
    expect(py).toContain('categorical = ["colour"]');
    expect(py).not.toContain('my "data"');
  });
});
