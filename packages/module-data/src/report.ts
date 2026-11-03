/** Markdown experiment reports built only from a stored run (no invented numbers). */
import type { ExperimentResult } from './ml/experiment.js';
import type { RunRow, VersionRow, DatasetRow } from './store.js';
import { MODEL_INFO } from './ml/models.js';

const f = (x: number | undefined | null, d = 4) => (x === undefined || x === null || !Number.isFinite(x) ? '—' : (+x.toFixed(d)).toString());
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function runReport(run: RunRow, r: ExperimentResult, version: VersionRow, dataset: DatasetRow): string {
  const L: string[] = [];
  const c = r.config;
  L.push(`# Experiment: ${run.name}`, '');
  L.push(`Recorded by AETHER Data Science & ML on ${run.createdAt}. Every number below was computed in this run.`, '');
  L.push('## Data', '');
  L.push(`- Dataset: **${dataset.name}**, version “${version.label}” (${version.rows.toLocaleString('en')} rows × ${version.cols} columns)`);
  L.push(`- Content SHA-256: \`${version.sha256}\``);
  if (dataset.source) L.push(`- Source: ${dataset.source}`);
  if (dataset.licence) L.push(`- Licence: ${dataset.licence}`);
  if (version.steps.length) L.push(`- Cleaning steps: ${version.steps.map((s) => s.op).join(' → ')}`);
  L.push(`- Target: \`${c.target}\` (${r.task}); features: ${c.features.map((x) => `\`${x}\``).join(', ')}`);
  L.push(`- Split: ${c.split.strategy}, ${Math.round(c.split.testFraction * 100)}% test, seed ${c.split.seed} → ${r.rows.train} train / ${r.rows.test} test rows${r.rows.dropped ? `, ${r.rows.dropped} rows without a target left out` : ''}`, '');
  L.push('## Model', '');
  L.push(`- ${MODEL_INFO[c.model].title} (trained with AETHER's built-in Epoch engine)`);
  if (c.classWeight === 'balanced') L.push('- Class weights: balanced');
  if (r.history?.bestEpoch) L.push(`- Best epoch/round (early stopping): ${r.history.bestEpoch}`);
  L.push(`- Parameters: \`${JSON.stringify(r.params)}\``);
  if (r.search) L.push(`- Chosen by ${c.search!.method} search over ${r.search.trials.length} settings with cross-validation on the training rows`);
  L.push(`- Training time: ${(r.durationMs / 1000).toFixed(1)} s`, '');
  L.push('## Results (test rows)', '');
  L.push(`| Metric | Model | Baseline | Train |`, `|---|---|---|---|`);
  if (r.metrics.task === 'classification' && r.baseline.task === 'classification' && r.trainMetrics.task === 'classification') {
    const rows: Array<[string, keyof typeof r.metrics]> = [['Accuracy', 'accuracy'], ['Balanced accuracy', 'balancedAccuracy'], ['F1 (macro)', 'f1Macro'], ['F1 (weighted)', 'f1Weighted'], ['ROC AUC', 'rocAuc'], ['Log loss', 'logLoss']];
    for (const [name, k] of rows) L.push(`| ${name} | ${f(r.metrics[k] as number)} | ${f(r.baseline[k] as number)} | ${f(r.trainMetrics[k] as number)} |`);
    L.push('', '### Confusion matrix (rows = actual, columns = predicted)', '');
    L.push(`| | ${r.metrics.labels.map(esc).join(' | ')} |`, `|---|${r.metrics.labels.map(() => '---').join('|')}|`);
    r.metrics.confusion.forEach((row, i) => L.push(`| **${esc((r.metrics as { labels: string[] }).labels[i])}** | ${row.join(' | ')} |`));
  } else if (r.metrics.task === 'regression' && r.baseline.task === 'regression' && r.trainMetrics.task === 'regression') {
    const rows: Array<[string, keyof typeof r.metrics]> = [['R²', 'r2'], ['MAE', 'mae'], ['RMSE', 'rmse'], ['Median abs. error', 'medianAbsError'], ['MAPE', 'mape']];
    for (const [name, k] of rows) L.push(`| ${name} | ${f(r.metrics[k] as number)} | ${f(r.baseline[k] as number)} | ${f(r.trainMetrics[k] as number)} |`);
  }
  if (r.cv) L.push('', `Cross-validation (${r.cv.folds} folds, training rows): ${r.cv.metric} ${f(r.cv.mean)} ± ${f(r.cv.std)}.`);
  L.push('', '## Feature importance (permutation, test rows)', '');
  L.push('| Feature | Drop in score when shuffled |', '|---|---|');
  r.importance.forEach((i) => L.push(`| ${esc(i.feature)} | ${f(i.value)} |`));
  if (r.leakage.length) {
    L.push('', '## Checks before training', '');
    r.leakage.forEach((l) => L.push(`- **${l.level}**: ${l.message}`));
  }
  if (r.errors.slices.length) {
    L.push('', `## Score by group (${r.task === 'classification' ? 'accuracy' : 'RMSE'})`, '');
    L.push('| Feature | Value | Rows | Score |', '|---|---|---|---|');
    r.errors.slices.forEach((s) => L.push(`| ${esc(s.feature)} | ${esc(s.value)} | ${s.n} | ${f(s.score)} |`));
  }
  L.push('', '## Limitations', '');
  L.push('- Results describe this dataset version and split only; they are not evidence the model works on other data.');
  L.push('- Permutation importance shows what this model relies on, not causal effects.');
  if (r.rows.test < 100) L.push(`- The test set is small (${r.rows.test} rows), so these metrics are noisy.`);
  if (run.notes) L.push('', '## Notes', '', run.notes);
  return L.join('\n') + '\n';
}
