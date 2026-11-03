/**
 * Epoch unsupervised methods used as pipeline steps: k-means clustering and
 * principal component analysis. Both standardise their input columns first and
 * skip rows with a missing value (the output for those rows is empty).
 */
import { DataError } from '../table.js';
import { mulberry32 } from '../rng.js';

export const UNSUP_LIMITS = { maxColumns: 200, maxK: 50, maxIter: 100 };

/** Standardised matrix of complete rows plus the indices they came from. */
export function standardise(cols: number[][]): { X: number[][]; rows: number[]; mean: number[]; std: number[] } {
  const d = cols.length;
  if (!d) throw new DataError('step', 'Choose at least one numeric column.');
  if (d > UNSUP_LIMITS.maxColumns) throw new DataError('step', `At most ${UNSUP_LIMITS.maxColumns} columns.`);
  const n = cols[0].length;
  const rows: number[] = [];
  for (let i = 0; i < n; i++) if (cols.every((c) => Number.isFinite(c[i]))) rows.push(i);
  const mean = cols.map((c) => rows.reduce((a, i) => a + c[i], 0) / (rows.length || 1));
  const std = cols.map((c, j) => Math.sqrt(rows.reduce((a, i) => a + (c[i] - mean[j]) ** 2, 0) / Math.max(1, rows.length - 1)) || 1);
  const X = rows.map((i) => cols.map((c, j) => (c[i] - mean[j]) / std[j]));
  return { X, rows, mean, std };
}

function dist2(a: number[], b: number[]): number {
  let s = 0;
  for (let j = 0; j < a.length; j++) s += (a[j] - b[j]) ** 2;
  return s;
}

/** k-means with k-means++ seeding (Lloyd iterations). Deterministic for a seed. */
export function kMeans(X: number[][], k: number, seed: number, maxIter = UNSUP_LIMITS.maxIter): { labels: number[]; centroids: number[][]; inertia: number; iterations: number } {
  const n = X.length;
  if (!Number.isInteger(k) || k < 2 || k > UNSUP_LIMITS.maxK) throw new DataError('step', `k must be between 2 and ${UNSUP_LIMITS.maxK}.`);
  if (n < k) throw new DataError('step', `Need at least ${k} complete rows for ${k} clusters.`);
  const rnd = mulberry32(seed >>> 0);
  const centroids: number[][] = [X[Math.floor(rnd() * n)].slice()];
  const dmin = X.map((x) => dist2(x, centroids[0]));
  while (centroids.length < k) {
    const total = dmin.reduce((a, b) => a + b, 0);
    let r = rnd() * total;
    let pick = n - 1;
    for (let i = 0; i < n; i++) { r -= dmin[i]; if (r <= 0) { pick = i; break; } }
    if (total === 0) pick = Math.floor(rnd() * n);
    centroids.push(X[pick].slice());
    for (let i = 0; i < n; i++) dmin[i] = Math.min(dmin[i], dist2(X[i], centroids[centroids.length - 1]));
  }
  const labels = new Array<number>(n).fill(-1);
  let iterations = 0;
  for (; iterations < maxIter; iterations++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const dd = dist2(X[i], centroids[c]); if (dd < bd) { bd = dd; best = c; } }
      if (labels[i] !== best) { labels[i] = best; changed++; }
    }
    const d = X[0].length;
    const sum = Array.from({ length: k }, () => new Array<number>(d).fill(0));
    const cnt = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) { cnt[labels[i]]++; for (let j = 0; j < d; j++) sum[labels[i]][j] += X[i][j]; }
    for (let c = 0; c < k; c++) if (cnt[c]) centroids[c] = sum[c].map((v) => v / cnt[c]);
    if (!changed) break;
  }
  const inertia = X.reduce((a, x, i) => a + dist2(x, centroids[labels[i]]), 0);
  // Relabel so cluster 0 is the largest, for stable, readable output.
  const sizes = new Array<number>(k).fill(0);
  labels.forEach((l) => sizes[l]++);
  const order = sizes.map((s, c) => [s, c] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]).map(([, c]) => c);
  const remap = new Array<number>(k);
  order.forEach((c, i) => (remap[c] = i));
  return { labels: labels.map((l) => remap[l]), centroids: order.map((c) => centroids[c]), inertia, iterations };
}

/** Symmetric eigen-decomposition by cyclic Jacobi rotations; eigenvalues sorted descending. */
export function symmetricEigen(Ain: number[][]): { values: number[]; vectors: number[][] } {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j): number => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-15) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => A[b][b] - A[a][a]);
  return { values: idx.map((i) => A[i][i]), vectors: idx.map((i) => V.map((row) => row[i])) };
}

/** PCA on standardised data: scores for the first `components` axes and the share of variance each explains. */
export function pca(X: number[][], components: number): { scores: number[][]; explained: number[]; loadings: number[][] } {
  const n = X.length;
  const d = X[0]?.length ?? 0;
  if (n < 2) throw new DataError('step', 'Need at least two complete rows.');
  const k = Math.min(Math.max(1, Math.floor(components)), d);
  const C = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (const x of X) for (let a = 0; a < d; a++) for (let b = a; b < d; b++) C[a][b] += (x[a] * x[b]) / (n - 1);
  for (let a = 0; a < d; a++) for (let b = 0; b < a; b++) C[a][b] = C[b][a];
  const { values, vectors } = symmetricEigen(C);
  const total = values.reduce((s, v) => s + Math.max(0, v), 0) || 1;
  const loadings = vectors.slice(0, k).map((v) => {
    // Sign convention: largest-magnitude loading positive, so results are reproducible.
    let m = 0;
    for (const x of v) if (Math.abs(x) > Math.abs(m)) m = x;
    return m < 0 ? v.map((x) => -x) : v;
  });
  const scores = X.map((x) => loadings.map((v) => v.reduce((s, vj, j) => s + vj * x[j], 0)));
  return { scores, explained: values.slice(0, k).map((v) => Math.max(0, v) / total), loadings };
}
