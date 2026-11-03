/**
 * Epoch's advanced learners: gradient-boosted trees, a multilayer perceptron
 * (neural network) and a linear support vector machine. Pure TypeScript, CPU
 * only, seeded, with early stopping on a held-out slice of the training rows
 * and a recorded training curve.
 */
import { DataError } from '../table.js';
import { mulberry32, shuffleInPlace, gaussian } from '../rng.js';
import { type FittedModel, type Task, type TrainContext, binFeatures, type TrainHistory } from './models.js';

export interface GbmParams { rounds: number; learningRate: number; maxDepth: number; minSamplesLeaf: number; l2: number; subsample: number; colsample: number; earlyStopping: number; seed: number }
export interface MlpParams { hiddenLayers: string; activation: 'relu' | 'tanh'; learningRate: number; batchSize: number; epochs: number; l2: number; earlyStopping: number; seed: number }
export interface SvmParams { C: number; epochs: number; learningRate: number; seed: number }

interface Node { f: number; t: number; l: number; r: number; v: number[] }

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

function softmaxInPlace(z: Float64Array | number[]): void {
  let m = -Infinity;
  for (const v of z) if (v > m) m = v;
  let s = 0;
  for (let i = 0; i < z.length; i++) { z[i] = Math.exp(z[i] - m); s += z[i]; }
  for (let i = 0; i < z.length; i++) z[i] /= s;
}

/** Splits training rows into fit / early-stopping validation (stratified by label for classification). */
function holdout(n: number, y: number[], task: Task, fraction: number, seed: number): { fit: number[]; val: number[] } {
  const all = Array.from({ length: n }, (_, i) => i);
  if (fraction <= 0 || n < 50) return { fit: all, val: [] };
  const rnd = mulberry32(seed ^ 0x5eed);
  if (task === 'regression') {
    shuffleInPlace(all, rnd);
    const k = Math.max(1, Math.round(n * fraction));
    return { fit: all.slice(k), val: all.slice(0, k) };
  }
  const by = new Map<number, number[]>();
  for (const i of all) (by.get(y[i]) ?? by.set(y[i], []).get(y[i])!).push(i);
  const fit: number[] = [];
  const val: number[] = [];
  for (const g of by.values()) {
    shuffleInPlace(g, rnd);
    const k = g.length > 4 ? Math.round(g.length * fraction) : 0;
    val.push(...g.slice(0, k));
    fit.push(...g.slice(k));
  }
  return { fit, val };
}

function downsample(xs: number[], max = 300): number[] {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  return Array.from({ length: max }, (_, i) => xs[Math.floor(i * step)]);
}

// ============================================================================ gradient boosting

/** Histogram tree on gradients/hessians (XGBoost-style gain), leaf = −G/(H+λ)·lr. */
async function gradTree(B: ReturnType<typeof binFeatures>, g: Float64Array, h: Float64Array, rows: number[], feats: number[], p: GbmParams, ctx: TrainContext, importance: number[]): Promise<Node[]> {
  const nodes: Node[] = [];
  const lam = p.l2;
  const build = async (idx: number[], depth: number): Promise<number> => {
    let G = 0, H = 0;
    for (const i of idx) { G += g[i]; H += h[i]; }
    const id = nodes.length;
    nodes.push({ f: -1, t: 0, l: -1, r: -1, v: [(-G / (H + lam)) * p.learningRate] });
    if (depth >= p.maxDepth || idx.length < 2 * p.minSamplesLeaf) return id;
    const parent = (G * G) / (H + lam);
    let best = { gain: 1e-9, f: -1, bin: -1 };
    for (const f of feats) {
      const th = B.thresholds[f];
      if (!th.length) continue;
      const nb = th.length + 1;
      const bf = B.bins[f];
      const hg = new Float64Array(nb), hh = new Float64Array(nb), hc = new Float64Array(nb);
      for (const i of idx) { const b = bf[i]; hg[b] += g[i]; hh[b] += h[i]; hc[b]++; }
      let gl = 0, hl = 0, cl = 0;
      for (let b = 0; b < nb - 1; b++) {
        gl += hg[b]; hl += hh[b]; cl += hc[b];
        const cr = idx.length - cl;
        if (cl < p.minSamplesLeaf || cr < p.minSamplesLeaf) continue;
        const gr = G - gl, hr = H - hl;
        const gain = (gl * gl) / (hl + lam) + (gr * gr) / (hr + lam) - parent;
        if (gain > best.gain) best = { gain, f, bin: b };
      }
    }
    if (best.f < 0) return id;
    const bf = B.bins[best.f];
    const left: number[] = [], right: number[] = [];
    for (const i of idx) (bf[i] <= best.bin ? left : right).push(i);
    importance[best.f] += best.gain;
    nodes[id].f = best.f;
    nodes[id].t = B.thresholds[best.f][best.bin];
    nodes[id].l = await build(left, depth + 1);
    nodes[id].r = await build(right, depth + 1);
    await ctx.tick();
    return id;
  };
  await build(rows, 0);
  return nodes;
}

function walk(nodes: Node[], x: number[]): number {
  let i = 0;
  while (nodes[i].f >= 0) i = x[nodes[i].f] <= nodes[i].t ? nodes[i].l : nodes[i].r;
  return nodes[i].v[0];
}

export async function fitGbm(X: number[][], y: number[], task: Task, k: number, p: GbmParams, ctx: TrainContext, w?: number[]): Promise<FittedModel> {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const K = task === 'regression' || k === 2 ? 1 : k;
  const B = binFeatures(X);
  const { fit, val } = holdout(n, y, task, p.earlyStopping > 0 ? 0.1 : 0, p.seed);
  const wt = (i: number) => (w ? w[i] : 1);
  // Initial scores.
  const base = new Array<number>(K).fill(0);
  if (task === 'regression') { let s = 0, ws = 0; for (const i of fit) { s += y[i] * wt(i); ws += wt(i); } base[0] = s / (ws || 1); }
  else {
    const c = new Array(k).fill(1e-3);
    for (const i of fit) c[y[i]] += wt(i);
    const tot = c.reduce((a, b) => a + b, 0);
    if (K === 1) { const p1 = c[1] / tot; base[0] = Math.log(p1 / (1 - p1)); }
    else for (let j = 0; j < k; j++) base[j] = Math.log(c[j] / tot);
  }
  const F = Array.from({ length: K }, (_, c) => new Float64Array(n).fill(base[c]));
  const g = Array.from({ length: K }, () => new Float64Array(n));
  const h = Array.from({ length: K }, () => new Float64Array(n));
  const rnd = mulberry32(p.seed);
  const trees: Node[][] = [];
  const importance = new Array(d).fill(0);
  const hist: TrainHistory = { metric: task === 'regression' ? 'MSE' : 'log loss', train: [], val: val.length ? [] : undefined };
  let bestVal = Infinity, bestRound = 0;
  const lossAt = (rows: number[]) => {
    let L = 0;
    for (const i of rows) {
      if (task === 'regression') L += (F[0][i] - y[i]) ** 2;
      else if (K === 1) { const q = sigmoid(F[0][i]); L -= Math.log(Math.max(1e-15, y[i] === 1 ? q : 1 - q)); }
      else { const z = F.map((f) => f[i]); softmaxInPlace(z); L -= Math.log(Math.max(1e-15, z[y[i]])); }
    }
    return L / (rows.length || 1);
  };
  for (let r = 0; r < p.rounds; r++) {
    // Gradients on all rows (validation rows are only scored, never fitted).
    for (const i of fit) {
      if (task === 'regression') { g[0][i] = (F[0][i] - y[i]) * wt(i); h[0][i] = wt(i); }
      else if (K === 1) { const q = sigmoid(F[0][i]); g[0][i] = (q - (y[i] === 1 ? 1 : 0)) * wt(i); h[0][i] = Math.max(1e-6, q * (1 - q)) * wt(i); }
      else {
        const z = F.map((f) => f[i]);
        softmaxInPlace(z);
        for (let c = 0; c < K; c++) { g[c][i] = (z[c] - (y[i] === c ? 1 : 0)) * wt(i); h[c][i] = Math.max(1e-6, z[c] * (1 - z[c])) * wt(i); }
      }
    }
    const rows = p.subsample < 1 ? fit.filter(() => rnd() < p.subsample) : fit;
    const feats = p.colsample < 1 ? shuffleInPlace(Array.from({ length: d }, (_, j) => j), rnd).slice(0, Math.max(1, Math.round(d * p.colsample))) : Array.from({ length: d }, (_, j) => j);
    for (let c = 0; c < K; c++) {
      const t = await gradTree(B, g[c], h[c], rows, feats, p, ctx, importance);
      trees.push(t);
      for (let i = 0; i < n; i++) F[c][i] += walk(t, X[i]);
    }
    hist.train.push(lossAt(fit));
    if (val.length) {
      const vl = lossAt(val);
      hist.val!.push(vl);
      if (vl < bestVal - 1e-9) { bestVal = vl; bestRound = r + 1; }
      else if (r + 1 - bestRound >= p.earlyStopping) break;
    } else bestRound = r + 1;
    await ctx.tick((r + 1) / p.rounds);
  }
  const kept = trees.slice(0, bestRound * K);
  hist.bestEpoch = bestRound;
  hist.train = downsample(hist.train);
  if (hist.val) hist.val = downsample(hist.val);
  const s = importance.reduce((a, b) => a + b, 0) || 1;
  return { type: 'gbm', task, params: { ...p }, nInputs: d, nClasses: task === 'regression' ? 0 : k, state: { base, outputs: K, trees: kept }, importance: importance.map((v) => v / s), history: hist };
}

export function predictGbm(m: FittedModel, X: number[][]): number[][] {
  const s = m.state as { base: number[]; outputs: number; trees: Node[][] };
  const K = s.outputs;
  return X.map((x) => {
    const z = s.base.slice();
    s.trees.forEach((t, i) => (z[i % K] += walk(t, x)));
    if (m.task === 'regression') return [z[0]];
    if (K === 1) { const q = sigmoid(z[0]); return [1 - q, q]; }
    softmaxInPlace(z);
    return z;
  });
}

// ============================================================================ neural network (MLP)

interface Layer { W: number[]; b: number[]; inp: number; out: number }

export function parseLayers(s: unknown): number[] {
  const parts = String(s ?? '').split(/[,\s]+/).filter(Boolean).map(Number);
  if (!parts.length || parts.length > 6 || parts.some((x) => !Number.isInteger(x) || x < 1 || x > 1024)) throw new DataError('ml', 'Hidden layers must be 1–6 sizes between 1 and 1024, e.g. "64, 32".');
  return parts;
}

function forward(layers: Layer[], act: 'relu' | 'tanh', x: ArrayLike<number>, keep?: Float64Array[]): Float64Array {
  let a = Float64Array.from(x as ArrayLike<number>);
  keep?.push(a);
  layers.forEach((L, li) => {
    const z = new Float64Array(L.out);
    for (let o = 0; o < L.out; o++) {
      let s = L.b[o];
      const off = o * L.inp;
      for (let j = 0; j < L.inp; j++) s += L.W[off + j] * a[j];
      z[o] = s;
    }
    if (li < layers.length - 1) for (let o = 0; o < L.out; o++) z[o] = act === 'relu' ? (z[o] > 0 ? z[o] : 0) : Math.tanh(z[o]);
    a = z;
    keep?.push(a);
  });
  return a;
}

export async function fitMlp(X: number[][], yIn: number[], task: Task, k: number, p: MlpParams, ctx: TrainContext, w?: number[]): Promise<FittedModel> {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const hidden = parseLayers(p.hiddenLayers);
  const outN = task === 'regression' ? 1 : k;
  const rnd = mulberry32(p.seed);
  // Regression target is standardised for stable training.
  let yMean = 0, yStd = 1;
  if (task === 'regression') { yMean = yIn.reduce((a, b) => a + b, 0) / n; yStd = Math.sqrt(yIn.reduce((a, b) => a + (b - yMean) ** 2, 0) / n) || 1; }
  const y = task === 'regression' ? yIn.map((v) => (v - yMean) / yStd) : yIn;
  const sizes = [d, ...hidden, outN];
  const layers: Layer[] = [];
  for (let l = 0; l + 1 < sizes.length; l++) {
    const inp = sizes[l], out = sizes[l + 1];
    const scale = p.activation === 'relu' ? Math.sqrt(2 / inp) : Math.sqrt(1 / inp);
    layers.push({ W: Array.from({ length: inp * out }, () => gaussian(rnd) * scale), b: new Array(out).fill(0), inp, out });
  }
  const mW = layers.map((L) => new Float64Array(L.W.length)), vW = layers.map((L) => new Float64Array(L.W.length));
  const mB = layers.map((L) => new Float64Array(L.out)), vB = layers.map((L) => new Float64Array(L.out));
  const { fit, val } = holdout(n, yIn, task, p.earlyStopping > 0 ? 0.1 : 0, p.seed);
  const hist: TrainHistory = { metric: task === 'regression' ? 'MSE (scaled)' : 'log loss', train: [], val: val.length ? [] : undefined };
  const lossOf = (out: Float64Array, i: number) => {
    if (task === 'regression') return (out[0] - y[i]) ** 2;
    const z = Float64Array.from(out);
    softmaxInPlace(z);
    return -Math.log(Math.max(1e-15, z[y[i]]));
  };
  let best = Infinity, bestEpoch = 0, bestLayers = layers.map((L) => ({ ...L, W: L.W.slice(), b: L.b.slice() }));
  let step = 0;
  const bs = Math.max(1, Math.min(p.batchSize, fit.length));
  for (let epoch = 1; epoch <= p.epochs; epoch++) {
    const order = shuffleInPlace(fit.slice(), rnd);
    let tl = 0;
    for (let s0 = 0; s0 < order.length; s0 += bs) {
      const batch = order.slice(s0, s0 + bs);
      const gW = layers.map((L) => new Float64Array(L.W.length));
      const gB = layers.map((L) => new Float64Array(L.out));
      for (const i of batch) {
        const acts: Float64Array[] = [];
        const out = forward(layers, p.activation, X[i], acts);
        tl += lossOf(out, i);
        const wi = w ? w[i] : 1;
        // Output delta.
        let delta: Float64Array;
        if (task === 'regression') delta = Float64Array.of(2 * (out[0] - y[i]) * wi);
        else { delta = Float64Array.from(out); softmaxInPlace(delta); delta[y[i]] -= 1; for (let o = 0; o < delta.length; o++) delta[o] *= wi; }
        for (let l = layers.length - 1; l >= 0; l--) {
          const L = layers[l];
          const a = acts[l];
          for (let o = 0; o < L.out; o++) {
            const dv = delta[o];
            if (dv === 0) continue;
            gB[l][o] += dv;
            const off = o * L.inp;
            for (let j = 0; j < L.inp; j++) gW[l][off + j] += dv * a[j];
          }
          if (l > 0) {
            const prev = new Float64Array(L.inp);
            for (let o = 0; o < L.out; o++) { const dv = delta[o]; if (dv === 0) continue; const off = o * L.inp; for (let j = 0; j < L.inp; j++) prev[j] += L.W[off + j] * dv; }
            const ap = acts[l];
            for (let j = 0; j < L.inp; j++) prev[j] *= p.activation === 'relu' ? (ap[j] > 0 ? 1 : 0) : 1 - ap[j] * ap[j];
            delta = prev;
          }
        }
      }
      step++;
      const b1 = 0.9, b2 = 0.999, eps = 1e-8, nb = batch.length;
      layers.forEach((L, l) => {
        for (let j = 0; j < L.W.length; j++) {
          const gr = gW[l][j] / nb + p.l2 * L.W[j];
          mW[l][j] = b1 * mW[l][j] + (1 - b1) * gr; vW[l][j] = b2 * vW[l][j] + (1 - b2) * gr * gr;
          L.W[j] -= (p.learningRate * (mW[l][j] / (1 - b1 ** step))) / (Math.sqrt(vW[l][j] / (1 - b2 ** step)) + eps);
        }
        for (let o = 0; o < L.out; o++) {
          const gr = gB[l][o] / nb;
          mB[l][o] = b1 * mB[l][o] + (1 - b1) * gr; vB[l][o] = b2 * vB[l][o] + (1 - b2) * gr * gr;
          L.b[o] -= (p.learningRate * (mB[l][o] / (1 - b1 ** step))) / (Math.sqrt(vB[l][o] / (1 - b2 ** step)) + eps);
        }
      });
      await ctx.tick((epoch - 1 + s0 / order.length) / p.epochs);
    }
    hist.train.push(tl / (fit.length || 1));
    if (val.length) {
      let vl = 0;
      for (const i of val) vl += lossOf(forward(layers, p.activation, X[i]), i);
      vl /= val.length;
      hist.val!.push(vl);
      if (!Number.isFinite(vl)) throw new DataError('ml', 'Training diverged (loss became infinite). Lower the learning rate.');
      if (vl < best - 1e-7) { best = vl; bestEpoch = epoch; bestLayers = layers.map((L) => ({ ...L, W: L.W.slice(), b: L.b.slice() })); }
      else if (epoch - bestEpoch >= p.earlyStopping) break;
    } else { bestEpoch = epoch; bestLayers = layers.map((L) => ({ ...L, W: L.W.slice(), b: L.b.slice() })); }
  }
  hist.bestEpoch = bestEpoch;
  hist.train = downsample(hist.train);
  if (hist.val) hist.val = downsample(hist.val);
  // First-layer weight magnitude as a rough importance.
  const L0 = bestLayers[0];
  const imp = Array.from({ length: d }, (_, j) => { let s = 0; for (let o = 0; o < L0.out; o++) s += Math.abs(L0.W[o * L0.inp + j]); return s; });
  const tot = imp.reduce((a, b) => a + b, 0) || 1;
  return { type: 'mlp', task, params: { ...p }, nInputs: d, nClasses: task === 'regression' ? 0 : k, state: { layers: bestLayers, activation: p.activation, yMean, yStd }, importance: imp.map((v) => v / tot), history: hist };
}

export function predictMlp(m: FittedModel, X: number[][]): number[][] {
  const s = m.state as { layers: Layer[]; activation: 'relu' | 'tanh'; yMean: number; yStd: number };
  return X.map((x) => {
    const out = forward(s.layers, s.activation, x);
    if (m.task === 'regression') return [out[0] * s.yStd + s.yMean];
    softmaxInPlace(out);
    return Array.from(out);
  });
}

// ============================================================================ linear SVM

export async function fitSvm(X: number[][], y: number[], k: number, p: SvmParams, ctx: TrainContext, w?: number[]): Promise<FittedModel> {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  const K = k === 2 ? 1 : k;
  const W = Array.from({ length: K }, () => new Float64Array(d + 1));
  const rnd = mulberry32(p.seed);
  const lam = 1 / (p.C * n);
  const hist: TrainHistory = { metric: 'hinge loss', train: [] };
  let t = 0;
  for (let epoch = 1; epoch <= p.epochs; epoch++) {
    const order = shuffleInPlace(Array.from({ length: n }, (_, i) => i), rnd);
    let loss = 0;
    for (const i of order) {
      t++;
      const eta = p.learningRate / (1 + p.learningRate * lam * t);
      const x = X[i];
      const wi = w ? w[i] : 1;
      for (let c = 0; c < K; c++) {
        const yc = K === 1 ? (y[i] === 1 ? 1 : -1) : y[i] === c ? 1 : -1;
        const wc = W[c];
        let m = wc[d];
        for (let j = 0; j < d; j++) m += wc[j] * x[j];
        const viol = 1 - yc * m;
        for (let j = 0; j < d; j++) wc[j] *= 1 - eta * lam;
        if (viol > 0) {
          loss += viol * wi;
          for (let j = 0; j < d; j++) wc[j] += eta * wi * yc * x[j];
          wc[d] += eta * wi * yc;
        }
      }
    }
    hist.train.push(loss / n);
    await ctx.tick(epoch / p.epochs);
  }
  hist.train = downsample(hist.train);
  const weights = W.map((x) => Array.from(x));
  const imp = Array.from({ length: d }, (_, j) => weights.reduce((s, wc) => s + Math.abs(wc[j]), 0));
  const tot = imp.reduce((a, b) => a + b, 0) || 1;
  return { type: 'svm', task: 'classification', params: { ...p }, nInputs: d, nClasses: k, state: { weights }, importance: imp.map((v) => v / tot), history: hist };
}

/** Scores turned into pseudo-probabilities (softmax of margins); they rank well but are not calibrated. */
export function predictSvm(m: FittedModel, X: number[][]): number[][] {
  const W = (m.state as { weights: number[][] }).weights;
  const d = m.nInputs;
  return X.map((x) => {
    const z = W.map((w) => { let s = w[d]; for (let j = 0; j < d; j++) s += w[j] * x[j]; return s; });
    if (W.length === 1) { const q = sigmoid(2 * z[0]); return [1 - q, q]; }
    softmaxInPlace(z);
    return z;
  });
}
