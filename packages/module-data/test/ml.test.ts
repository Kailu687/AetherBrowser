import { describe, expect, it } from 'vitest';
import { runExperiment, predictWith, searchTrials } from '../src/ml/experiment.js';
import { classificationMetrics, regressionMetrics, rocAuc } from '../src/ml/metrics.js';
import { kFolds, randomSplit, stratifiedSplit, groupSplit, timeSplit } from '../src/ml/split.js';
import { fitModel, predictLabels, solveSpd, TrainContext, type ModelType } from '../src/ml/models.js';
import { synthClassification, synthRegression } from './helpers.js';

const split = { strategy: 'stratified' as const, testFraction: 0.25, seed: 7 };

describe('native trainer: classification', () => {
  const t = synthClassification();
  for (const model of ['logistic', 'tree', 'forest', 'knn', 'naiveBayes'] as ModelType[]) {
    it(`${model} beats the baseline clearly`, async () => {
      const r = await runExperiment(t, { target: 'label', features: ['x', 'y', 'colour'], task: 'auto', model, params: model === 'forest' ? { trees: 20 } : {}, split });
      expect(r.task).toBe('classification');
      expect(r.metrics.task === 'classification' && r.metrics.accuracy).toBeGreaterThan(0.8);
      expect(r.primary.value).toBeGreaterThan(r.primary.baseline + 0.2);
      expect(r.rows.train + r.rows.test).toBe(600);
      expect(r.importance[0].feature).toBe('x');
    });
  }
  it('is reproducible from the seed', async () => {
    const cfg = { target: 'label', features: ['x', 'y'], task: 'classification' as const, model: 'forest' as const, params: { trees: 10, seed: 3 }, split };
    const a = await runExperiment(t, cfg);
    const b = await runExperiment(t, cfg);
    expect(a.metrics).toEqual(b.metrics);
  });
  it('runs cross-validation and search on training rows', async () => {
    const r = await runExperiment(t, { target: 'label', features: ['x', 'y'], task: 'classification', model: 'tree', split, cvFolds: 3, search: { method: 'grid', space: { maxDepth: [1, 4] } } });
    expect(r.cv!.scores).toHaveLength(3);
    expect(r.search!.trials).toHaveLength(2);
    expect(r.search!.best.maxDepth).toBe(4);
  });
  it('flags leakage: target proxy and identifier', async () => {
    const leaky = { columns: [...t.columns, { name: 'label_code', values: t.columns[4].values.map((v) => (v === 'yes' ? 1 : 0)) }] };
    const r = await runExperiment(leaky, { target: 'label', features: ['x', 'id', 'label_code'], task: 'classification', model: 'logistic', split });
    expect(r.leakage.some((f) => f.code === 'target-proxy' && f.column === 'label_code')).toBe(true);
    expect(r.leakage.some((f) => f.code === 'identifier' && f.column === 'id')).toBe(true);
  });
  it('exports an artifact that predicts new rows', async () => {
    const r = await runExperiment(t, { target: 'label', features: ['x', 'y', 'colour'], task: 'classification', model: 'logistic', split });
    const art = JSON.parse(JSON.stringify(r.artifact));
    const p = predictWith(art, [{ x: 3, y: -1, colour: 'red' }, { x: -3, y: 2, colour: 'blue' }, { x: null, y: null, colour: 'purple' }]);
    expect(p[0].prediction).toBe('yes');
    expect(p[1].prediction).toBe('no');
    expect(Object.values(p[2].proba!).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it('rejects the target as a feature and unknown models', async () => {
    await expect(runExperiment(t, { target: 'label', features: ['label'], task: 'auto', model: 'tree', split })).rejects.toThrow(/target/);
    await expect(runExperiment(t, { target: 'label', features: ['x'], task: 'auto', model: 'quantum' as ModelType, split })).rejects.toThrow(/Unknown model/);
  });
  it('honours cancellation', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runExperiment(t, { target: 'label', features: ['x', 'y'], task: 'auto', model: 'forest', params: { trees: 300 }, split }, { signal: ac.signal })).rejects.toThrow(/cancelled/);
  });
});

describe('native trainer: regression', () => {
  const t = synthRegression();
  for (const model of ['linear', 'tree', 'forest', 'knn'] as ModelType[]) {
    it(`${model} fits y = 3x + 2`, async () => {
      const r = await runExperiment(t, { target: 'target', features: ['x', 'junk'], task: 'regression', model, params: model === 'forest' ? { trees: 20 } : {}, split: { strategy: 'random', testFraction: 0.2, seed: 1 } });
      expect(r.metrics.task === 'regression' && r.metrics.r2).toBeGreaterThan(model === 'linear' ? 0.98 : 0.9);
      expect(r.primary.baseline).toBeLessThan(0.05);
    });
  }
  it('linear recovers the coefficients (unscaled)', async () => {
    const r = await runExperiment(t, { target: 'target', features: ['x'], task: 'regression', model: 'linear', params: { l2: 0 }, scale: false, split: { strategy: 'random', testFraction: 0.2, seed: 1 } });
    const s = r.artifact.model.state as { w: number[]; intercept: number };
    expect(s.w[0]).toBeCloseTo(3, 1);
    expect(s.intercept).toBeCloseTo(2, 0);
  });
});

describe('metrics and splits', () => {
  it('computes known values', () => {
    const m = classificationMetrics([0, 0, 1, 1], [0, 1, 1, 1], ['a', 'b']);
    expect(m.accuracy).toBe(0.75);
    expect(m.confusion).toEqual([[1, 1], [0, 2]]);
    expect(rocAuc([0, 0, 1, 1], [0.1, 0.4, 0.35, 0.8])).toBeCloseTo(0.75);
    const r = regressionMetrics([1, 2, 3], [1, 2, 4]);
    expect(r.mae).toBeCloseTo(1 / 3);
    expect(r.r2).toBeCloseTo(0.5);
  });
  it('splits without overlap and respects groups/time', () => {
    const rows = Array.from({ length: 100 }, (_, i) => i);
    const s = randomSplit(rows, 0.2, 1);
    expect(s.test.length).toBe(20);
    expect(new Set([...s.train, ...s.test]).size).toBe(100);
    const labels = rows.map((i) => (i < 10 ? 'rare' : 'common'));
    expect(stratifiedSplit(rows, labels, 0.2, 1).test.filter((i) => i < 10).length).toBe(2);
    const groups = rows.map((i) => `g${i % 10}`);
    const g = groupSplit(rows, groups, 0.3, 1);
    const tg = new Set(g.train.map((i) => groups[i]));
    expect(g.test.every((i) => !tg.has(groups[i]))).toBe(true);
    const times = rows.map((i) => `2024-01-${String((i % 28) + 1).padStart(2, '0')}`);
    const ts = timeSplit(rows, times, 0.25);
    expect(Math.max(...ts.train.map((i) => Date.parse(times[i])))).toBeLessThanOrEqual(Math.min(...ts.test.map((i) => Date.parse(times[i]))));
    const folds = kFolds(rows, 5, 1);
    expect(folds.flatMap((f) => f.test).sort((a, b) => a - b)).toEqual(rows);
  });
  it('solves SPD systems and enumerates search trials', () => {
    expect(solveSpd([[4, 1], [1, 3]], [1, 2]).map((v) => +v.toFixed(4))).toEqual([0.0909, 0.6364]);
    expect(searchTrials({ a: [1, 2], b: ['x', 'y', 'z'] }, 'grid', 100, 1)).toHaveLength(6);
    expect(searchTrials({ a: [1, 2], b: ['x', 'y', 'z'] }, 'random', 4, 1)).toHaveLength(4);
  });
  it('rejects models used for the wrong task', async () => {
    await expect(fitModel('linear', 'classification', [[1], [2]], [0, 1], 2, {}, new TrainContext())).rejects.toThrow(/does not do/);
    const m = await fitModel('tree', 'classification', [[0], [1], [2], [3]], [0, 0, 1, 1], 2, { minSamplesLeaf: 1 });
    expect(predictLabels(m, [[0.2], [2.8]])).toEqual([0, 1]);
  });
});
