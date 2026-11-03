import type { ExperimentResult } from '../ml/experiment.js';
import { Bars, Heatmap, LearningCurve, RocChart, fmt, pct } from './common.js';

export type ResultSummary = Omit<ExperimentResult, 'artifact'> & { artifactBytes?: number };

const LEVEL_ICON = { risk: '⛔', warn: '⚠️', info: 'ℹ️' } as const;

export function ResultsView({ r }: { r: ResultSummary }) {
  const m = r.metrics;
  const b = r.baseline;
  const t = r.trainMetrics;
  const gap = r.primary.value - r.primary.baseline;
  const overfit = m.task === 'classification' && t.task === 'classification' ? t.accuracy - m.accuracy : m.task === 'regression' && t.task === 'regression' ? t.r2 - m.r2 : 0;
  return (
    <div className="dsm-results">
      <div className="dsm-stats">
        <div className="wb-card dsm-primary"><b>{fmt(r.primary.value, 3)}</b><span>{r.primary.name} on {fmt(r.rows.test)} test rows</span></div>
        <div className="wb-card"><b>{fmt(r.primary.baseline, 3)}</b><span>baseline</span></div>
        {r.cv && <div className="wb-card"><b>{fmt(r.cv.mean, 3)} ± {fmt(r.cv.std, 3)}</b><span>{r.cv.folds}-fold CV on training rows</span></div>}
        <div className="wb-card"><b>{(r.durationMs / 1000).toFixed(1)} s</b><span>{fmt(r.rows.train)} training rows</span></div>
      </div>
      {gap <= 0.01 && <div className="dsm-warnbox warn">The model does not beat the baseline. The features may not carry signal for this target, or the model needs different settings.</div>}
      {overfit > 0.15 && <div className="dsm-warnbox warn">Training score is much higher than test score ({fmt(overfit, 2)} gap): the model is probably overfitting. Try a shallower tree, fewer features or more regularisation.</div>}
      {r.leakage.length > 0 && (
        <section>
          <h4>Checks before training</h4>
          <ul className="dsm-checks">{r.leakage.map((l, i) => <li key={i} className={`dsm-${l.level}`}>{LEVEL_ICON[l.level]} {l.message}</li>)}</ul>
        </section>
      )}
      <section>
        <h4>Metrics</h4>
        <table className="wb-table dsm-metrics">
          <thead><tr><th>Metric</th><th>Test</th><th>Baseline</th><th>Train</th></tr></thead>
          <tbody>
            {m.task === 'classification' && b.task === 'classification' && t.task === 'classification' ? (
              ([['Accuracy', 'accuracy'], ['Balanced accuracy', 'balancedAccuracy'], ['Precision (macro)', 'precisionMacro'], ['Recall (macro)', 'recallMacro'], ['F1 (macro)', 'f1Macro'], ['F1 (weighted)', 'f1Weighted'], ['ROC AUC', 'rocAuc'], ['Log loss (lower is better)', 'logLoss']] as const).map(([label, k]) => <tr key={k}><td>{label}</td><td>{fmt(m[k], 4)}</td><td>{fmt(b[k], 4)}</td><td>{fmt(t[k], 4)}</td></tr>)
            ) : m.task === 'regression' && b.task === 'regression' && t.task === 'regression' ? (
              ([['R²', 'r2'], ['MAE', 'mae'], ['RMSE', 'rmse'], ['Median absolute error', 'medianAbsError'], ['MAPE', 'mape']] as const).map(([label, k]) => <tr key={k}><td>{label}</td><td>{k === 'mape' ? pct(m[k]) : fmt(m[k], 4)}</td><td>{k === 'mape' ? pct(b[k]) : fmt(b[k], 4)}</td><td>{k === 'mape' ? pct(t[k]) : fmt(t[k], 4)}</td></tr>)
            ) : null}
          </tbody>
        </table>
      </section>
      {m.task === 'classification' && (
        <section className="dsm-two">
          <div>
            <h4>Confusion matrix</h4>
            <p className="dsm-muted dsm-small">Rows are actual classes, columns are predictions.</p>
            <Heatmap title="Confusion matrix" rows={m.labels} cols={m.labels} values={m.confusion} format={(v) => fmt(v)} />
            <table className="wb-table dsm-small">
              <thead><tr><th>Class</th><th>Precision</th><th>Recall</th><th>F1</th><th>Support</th></tr></thead>
              <tbody>{m.perClass.map((c) => <tr key={c.label}><td>{c.label}</td><td>{fmt(c.precision, 3)}</td><td>{fmt(c.recall, 3)}</td><td>{fmt(c.f1, 3)}</td><td>{c.support}</td></tr>)}</tbody>
            </table>
          </div>
          {r.roc && <div><h4>ROC curve</h4><RocChart fpr={r.roc.fpr} tpr={r.roc.tpr} auc={m.rocAuc} /></div>}
        </section>
      )}
      {r.history && r.history.train.length > 1 && (
        <section>
          <h3>Training curve</h3>
          <LearningCurve train={r.history.train} val={r.history.val} metric={r.history.metric} best={r.history.bestEpoch} />
          {r.history.val && <p className="dsm-muted dsm-small">If the validation line rises while training keeps falling, the model is overfitting; early stopping keeps the best point.</p>}
        </section>
      )}
      <section className="dsm-two">
        <div>
          <h4>Permutation importance</h4>
          <p className="dsm-muted dsm-small">How much the test {r.primary.name} drops when a column is shuffled. Near zero or negative means the model does not rely on it.</p>
          <Bars signed items={r.importance.map((i) => ({ label: i.feature, value: i.value }))} />
        </div>
        {r.modelImportance && (
          <div>
            <h4>{r.config.model === 'tree' || r.config.model === 'forest' ? 'Impurity importance' : 'Coefficient size (scaled inputs)'}</h4>
            <Bars items={r.modelImportance.slice(0, 15).map((i) => ({ label: i.input, value: i.value }))} />
          </div>
        )}
      </section>
      {r.search && (
        <section>
          <h4>Hyperparameter search ({r.search.trials.length} settings)</h4>
          <table className="wb-table dsm-small">
            <thead><tr><th>Settings</th><th>CV {r.primary.name}</th></tr></thead>
            <tbody>{r.search.trials.slice(0, 15).map((s, i) => <tr key={i} className={i === 0 ? 'dsm-best' : ''}><td className="dsm-mono">{JSON.stringify(s.params)}</td><td>{fmt(s.cvMean, 4)}</td></tr>)}</tbody>
          </table>
        </section>
      )}
      <section>
        <h4>Error analysis</h4>
        {r.errors.slices.length > 0 && (
          <table className="wb-table dsm-small">
            <thead><tr><th>Group</th><th>Rows</th><th>{r.task === 'classification' ? 'Accuracy' : 'RMSE'}</th></tr></thead>
            <tbody>{r.errors.slices.map((s, i) => <tr key={i}><td>{s.feature} = {s.value}</td><td>{s.n}</td><td>{fmt(s.score, 3)}</td></tr>)}</tbody>
          </table>
        )}
        {r.errors.worst.length > 0 ? (
          <table className="wb-table dsm-small">
            <thead><tr><th>Row</th><th>Actual</th><th>Predicted</th><th>{r.task === 'classification' ? 'Confidence' : 'Abs. error'}</th></tr></thead>
            <tbody>{r.errors.worst.slice(0, 12).map((w) => <tr key={w.row}><td>{w.row + 1}</td><td>{fmt(w.actual)}</td><td>{fmt(w.predicted)}</td><td>{fmt(w.error, 3)}</td></tr>)}</tbody>
          </table>
        ) : <p className="dsm-muted">No errors on the test rows.</p>}
      </section>
      <p className="dsm-muted dsm-small">Settings: <span className="dsm-mono">{JSON.stringify(r.params)}</span> · split {r.config.split.strategy}, seed {r.config.split.seed}. These results describe this dataset version and split only.</p>
    </div>
  );
}
