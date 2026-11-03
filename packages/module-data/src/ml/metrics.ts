export interface ClassificationMetrics {
  task: 'classification';
  n: number;
  accuracy: number;
  balancedAccuracy: number;
  precisionMacro: number;
  recallMacro: number;
  f1Macro: number;
  f1Weighted: number;
  /** Only for two classes, with class index 1 as positive. */
  rocAuc?: number;
  logLoss?: number;
  perClass: { label: string; precision: number; recall: number; f1: number; support: number }[];
  /** confusion[actual][predicted] */
  confusion: number[][];
  labels: string[];
}

export interface RegressionMetrics {
  task: 'regression';
  n: number;
  mae: number;
  mse: number;
  rmse: number;
  r2: number;
  /** Skips rows where the true value is 0. */
  mape: number;
  medianAbsError: number;
}

export type Metrics = ClassificationMetrics | RegressionMetrics;

const safe = (a: number, b: number) => (b === 0 ? 0 : a / b);

export function classificationMetrics(yTrue: number[], yPred: number[], labels: string[], proba?: number[][]): ClassificationMetrics {
  const k = labels.length;
  const confusion = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < yTrue.length; i++) confusion[yTrue[i]][yPred[i]]++;
  const perClass = labels.map((label, c) => {
    const tp = confusion[c][c];
    const support = confusion[c].reduce((a, b) => a + b, 0);
    const predicted = confusion.reduce((a, row) => a + row[c], 0);
    const precision = safe(tp, predicted);
    const recall = safe(tp, support);
    return { label, precision, recall, f1: safe(2 * precision * recall, precision + recall), support };
  });
  const n = yTrue.length;
  const correct = labels.reduce((a, _, c) => a + confusion[c][c], 0);
  const present = perClass.filter((p) => p.support > 0);
  const m: ClassificationMetrics = {
    task: 'classification',
    n,
    accuracy: safe(correct, n),
    balancedAccuracy: present.length ? present.reduce((a, p) => a + p.recall, 0) / present.length : 0,
    precisionMacro: perClass.reduce((a, p) => a + p.precision, 0) / k,
    recallMacro: perClass.reduce((a, p) => a + p.recall, 0) / k,
    f1Macro: perClass.reduce((a, p) => a + p.f1, 0) / k,
    f1Weighted: safe(perClass.reduce((a, p) => a + p.f1 * p.support, 0), n),
    perClass,
    confusion,
    labels,
  };
  if (proba) {
    let ll = 0;
    for (let i = 0; i < n; i++) ll -= Math.log(Math.min(1 - 1e-15, Math.max(1e-15, proba[i][yTrue[i]])));
    m.logLoss = ll / n;
    if (k === 2) m.rocAuc = rocAuc(yTrue, proba.map((p) => p[1]));
  }
  return m;
}

/** ROC AUC via the rank statistic (ties get average rank). NaN if only one class is present. */
export function rocAuc(yTrue: number[], score: number[]): number {
  const idx = score.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(score.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  let pos = 0;
  let sum = 0;
  yTrue.forEach((y, k) => { if (y === 1) { pos++; sum += ranks[k]; } });
  const neg = yTrue.length - pos;
  if (pos === 0 || neg === 0) return NaN;
  return (sum - (pos * (pos + 1)) / 2) / (pos * neg);
}

export function rocCurve(yTrue: number[], score: number[], points = 50): { fpr: number[]; tpr: number[] } {
  const thresholds = [...new Set(score)].sort((a, b) => b - a);
  const step = Math.max(1, Math.floor(thresholds.length / points));
  const P = yTrue.filter((y) => y === 1).length;
  const N = yTrue.length - P;
  const fpr = [0];
  const tpr = [0];
  for (let t = 0; t < thresholds.length; t += step) {
    let tp = 0;
    let fp = 0;
    for (let i = 0; i < score.length; i++) if (score[i] >= thresholds[t]) { if (yTrue[i] === 1) tp++; else fp++; }
    fpr.push(safe(fp, N));
    tpr.push(safe(tp, P));
  }
  fpr.push(1);
  tpr.push(1);
  return { fpr, tpr };
}

export function regressionMetrics(yTrue: number[], yPred: number[]): RegressionMetrics {
  const n = yTrue.length;
  let ae = 0;
  let se = 0;
  let ape = 0;
  let apeN = 0;
  const abs: number[] = [];
  const m = yTrue.reduce((a, b) => a + b, 0) / (n || 1);
  let tot = 0;
  for (let i = 0; i < n; i++) {
    const e = yPred[i] - yTrue[i];
    ae += Math.abs(e);
    se += e * e;
    abs.push(Math.abs(e));
    tot += (yTrue[i] - m) ** 2;
    if (yTrue[i] !== 0) { ape += Math.abs(e / yTrue[i]); apeN++; }
  }
  abs.sort((a, b) => a - b);
  const mse = safe(se, n);
  return { task: 'regression', n, mae: safe(ae, n), mse, rmse: Math.sqrt(mse), r2: tot === 0 ? 0 : 1 - se / tot, mape: safe(ape, apeN), medianAbsError: abs.length ? (abs.length % 2 ? abs[(abs.length - 1) / 2] : (abs[abs.length / 2 - 1] + abs[abs.length / 2]) / 2) : 0 };
}

/** The single number used to rank runs: higher is better. */
export function primaryScore(m: Metrics): { name: string; value: number } {
  return m.task === 'classification' ? (m.rocAuc !== undefined && Number.isFinite(m.rocAuc) ? { name: 'ROC AUC', value: m.rocAuc } : { name: 'F1 (macro)', value: m.f1Macro }) : { name: 'R²', value: m.r2 };
}
