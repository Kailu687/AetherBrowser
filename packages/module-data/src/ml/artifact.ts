/**
 * Validation for model files imported from disk. A model file is data, but a
 * hostile one could hang prediction (a tree whose child points back to its
 * parent) or exhaust memory, so every structure is checked before use.
 */
import { DataError } from '../table.js';
import type { TrainedArtifact } from './experiment.js';
import { MODEL_INFO, type ModelType } from './models.js';

const MAX_BYTES = 200 * 1024 * 1024;
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const numArr = (v: unknown, len?: number) => Array.isArray(v) && (len === undefined || v.length === len) && v.every(isNum);
const fail = (why: string): never => { throw new DataError('bad-model', `Not a valid AETHER model file: ${why}.`); };

function checkTree(nodes: unknown, nInputs: number, valueLen: number): void {
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > 1_000_000) fail('tree size');
  const ns = nodes as Array<Record<string, unknown>>;
  ns.forEach((n, i) => {
    if (!n || typeof n !== 'object' || !Number.isInteger(n.f) || !isNum(n.t) || !numArr(n.v, valueLen)) fail('tree node');
    const f = n.f as number;
    if (f >= 0) {
      if (f >= nInputs) fail('tree feature index');
      for (const c of [n.l, n.r]) if (!Number.isInteger(c) || (c as number) <= i || (c as number) >= ns.length) fail('tree child index');
    }
  });
}

export function validateArtifact(raw: unknown, bytes = 0): TrainedArtifact {
  if (bytes > MAX_BYTES) fail('file too large');
  const a = raw as TrainedArtifact;
  if (!a || typeof a !== 'object' || a.format !== 'aether-data-model' || a.version !== 1) fail('format/version');
  if (!a.target || (a.target.task !== 'classification' && a.target.task !== 'regression') || typeof a.target.name !== 'string') fail('target');
  const k = a.target.task === 'classification' ? (Array.isArray(a.target.classes) && a.target.classes.length >= 2 && a.target.classes.length <= 100 && a.target.classes.every((c) => typeof c === 'string') ? a.target.classes.length : fail('classes')) : 0;
  const p = a.preprocessor;
  if (!p || !Array.isArray(p.features) || !Array.isArray(p.outputNames) || p.outputNames.length > 1000) fail('preprocessor');
  let width = 0;
  for (const f of p.features) {
    if (!f || typeof f.name !== 'string') fail('feature');
    if (f.kind === 'numeric') { if (![f.median, f.mean, f.std].every(isNum) || f.std === 0) fail('numeric feature'); width += f.missingIndicator ? 2 : 1; }
    else if (f.kind === 'categorical') { if (!Array.isArray(f.categories) || f.categories.length > 200 || !f.categories.every((c) => typeof c === 'string')) fail('categorical feature'); width += f.categories.length + (f.other ? 1 : 0); }
    else if (f.kind === 'text') { if (!Array.isArray(f.vocab) || f.vocab.length > 500 || !f.vocab.every((w) => typeof w === 'string' && w.length <= 64) || !numArr(f.idf, f.vocab.length)) fail('text feature'); width += f.vocab.length; }
    else fail('feature kind');
  }
  if (width !== p.outputNames.length) fail('feature width');
  const m = a.model;
  if (!m || !MODEL_INFO[m.type as ModelType] || m.task !== a.target.task || m.nInputs !== width) fail('model header');
  if (k && m.nClasses !== k) fail('class count');
  const s = m.state as Record<string, unknown>;
  if (!s || typeof s !== 'object') fail('model state');
  const vlen = k || 1;
  switch (m.type) {
    case 'baseline': if (k ? !numArr(s.proba, k) : !isNum(s.mean)) fail('baseline'); break;
    case 'linear': if (!numArr(s.w, width) || !isNum(s.intercept)) fail('linear weights'); break;
    case 'logistic': if (!Array.isArray(s.weights) || s.weights.length !== k || !s.weights.every((w) => numArr(w, width + 1))) fail('logistic weights'); break;
    case 'knn': if (!Array.isArray(s.X) || s.X.length > 50_000 || !s.X.every((x) => numArr(x, width)) || !numArr(s.y, (s.X as unknown[]).length)) fail('knn data'); break;
    case 'naiveBayes': if (![s.mu, s.va].every((t) => Array.isArray(t) && t.length === k && t.every((r) => numArr(r, width))) || !numArr(s.prior, k)) fail('naive Bayes'); break;
    case 'tree': checkTree(s.nodes, width, vlen); break;
    case 'forest': if (!Array.isArray(s.trees) || s.trees.length === 0 || s.trees.length > 1000) fail('forest'); (s.trees as unknown[]).forEach((t) => checkTree(t, width, vlen)); break;
    case 'gbm': {
      const K = k === 2 || !k ? 1 : k;
      if (s.outputs !== K || !numArr(s.base, K) || !Array.isArray(s.trees) || s.trees.length > 50_000) fail('boosting');
      (s.trees as unknown[]).forEach((t) => checkTree(t, width, 1));
      break;
    }
    case 'mlp': {
      if (!Array.isArray(s.layers) || s.layers.length < 2 || s.layers.length > 7 || (s.activation !== 'relu' && s.activation !== 'tanh') || !isNum(s.yMean) || !isNum(s.yStd)) fail('network');
      let inp = width;
      let total = 0;
      for (const L of s.layers as Array<Record<string, unknown>>) {
        if (!L || L.inp !== inp || !Number.isInteger(L.out) || (L.out as number) < 1 || (L.out as number) > 1024) fail('network layer');
        total += inp * (L.out as number);
        if (total > 5_000_000 || !numArr(L.W, inp * (L.out as number)) || !numArr(L.b, L.out as number)) fail('network weights');
        inp = L.out as number;
      }
      if (inp !== vlen) fail('network output');
      break;
    }
    case 'svm': if (!Array.isArray(s.weights) || s.weights.length !== (k === 2 ? 1 : k) || !s.weights.every((w) => numArr(w, width + 1))) fail('SVM weights'); break;
  }
  if (!Array.isArray(a.inputs) || !a.inputs.every((x) => typeof x === 'string')) fail('inputs');
  return a;
}
