import { useEffect, useMemo, useState } from 'react';
import type { ExperimentConfig } from '../ml/experiment.js';
import { type Api, type ColumnSchema, type VersionRow, Empty, ErrorBox, VersionPicker, errText, looksLikeIdName, useLoad } from './common.js';
import { ResultsView, type ResultSummary } from './Results.js';

interface ModelInfo { type: ExperimentConfig['model']; title: string; tasks: string[]; note: string; defaults: Record<string, number | string> }

const PARAM_HELP: Record<string, string> = {
  l2: 'Regularisation strength (higher = simpler model)',
  epochs: 'Training passes over the data',
  learningRate: 'Step size',
  k: 'Number of neighbours',
  weights: 'uniform or distance',
  varSmoothing: 'Variance added for stability',
  maxDepth: 'Maximum tree depth',
  minSamplesLeaf: 'Minimum rows in a leaf',
  trees: 'Number of trees',
  maxFeatures: 'Features tried per split: sqrt, log2 or all',
  seed: 'Random seed',
  rounds: 'Boosting rounds (trees per class); early stopping may use fewer',
  subsample: 'Share of rows used for each tree (0.1–1)',
  colsample: 'Share of features tried for each tree (0.1–1)',
  earlyStopping: 'Stop after this many rounds/epochs without validation improvement (0 = off)',
  hiddenLayers: 'Neurons per hidden layer, comma-separated, e.g. 64,32',
  activation: 'relu or tanh',
  batchSize: 'Rows per gradient step',
  C: 'Inverse regularisation: higher fits the training data more closely',
};

const SEARCH_PRESETS: Record<string, Record<string, Array<number | string>>> = {
  linear: { l2: [0, 0.001, 0.01, 0.1, 1] },
  logistic: { l2: [0, 0.001, 0.01, 0.1] },
  knn: { k: [3, 5, 9, 15, 25], weights: ['uniform', 'distance'] },
  tree: { maxDepth: [3, 5, 8, 12], minSamplesLeaf: [1, 5, 20] },
  forest: { maxDepth: [6, 10, 16], minSamplesLeaf: [1, 3, 10] },
  naiveBayes: { varSmoothing: [1e-9, 1e-6, 1e-3] },
  gbm: { learningRate: [0.05, 0.1, 0.2], maxDepth: [3, 4, 6] },
  mlp: { hiddenLayers: ['32', '64,32', '128,64'], l2: [1e-4, 1e-3] },
  svm: { C: [0.1, 1, 10] },
};

export function TrainerApp({ api }: { api: Api }) {
  const [versionId, setVersionId] = useState(api.arg && /^[0-9a-f-]{36}$/.test(api.arg) ? api.arg : '');
  const meta = useLoad<{ version: VersionRow; schema: { columns: ColumnSchema[] } }>(api, 'version.get', versionId ? { versionId } : undefined, [versionId]);
  const models = useLoad<ModelInfo[]>(api, 'ml.models', {}, []);
  const columns = meta.data?.schema.columns ?? [];
  const [target, setTarget] = useState('');
  const [features, setFeatures] = useState<string[]>([]);
  const [task, setTask] = useState<ExperimentConfig['task']>('auto');
  const [model, setModel] = useState<ExperimentConfig['model']>('forest');
  const [params, setParams] = useState<Record<string, number | string>>({});
  const [strategy, setStrategy] = useState<ExperimentConfig['split']['strategy']>('stratified');
  const [testFraction, setTestFraction] = useState(0.2);
  const [seed, setSeed] = useState(42);
  const [groupBy, setGroupBy] = useState('');
  const [timeColumn, setTimeColumn] = useState('');
  const [cvFolds, setCvFolds] = useState(0);
  const [search, setSearch] = useState(false);
  const [timeLimit, setTimeLimit] = useState(120);
  const [classWeight, setClassWeight] = useState<'none' | 'balanced'>('none');
  const [name, setName] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ stage: string; progress: number } | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ runId: string; result: ResultSummary } | null>(null);

  useEffect(() => {
    if (!columns.length) return;
    const last = columns[columns.length - 1].name;
    setTarget((t) => (columns.some((c) => c.name === t) ? t : last));
    setFeatures((f) => { const keep = f.filter((x) => columns.some((c) => c.name === x)); return keep.length ? keep : columns.filter((c) => c.name !== last && c.type !== 'text' && c.type !== 'empty' && !looksLikeIdName(c.name)).map((c) => c.name); });
  }, [columns]);
  useEffect(() => api.on('ml.progress', (p) => setProgress(p as { stage: string; progress: number })), [api]);
  const info = models.data?.find((m) => m.type === model);
  useEffect(() => { if (info) setParams({ ...info.defaults }); }, [info]);

  const targetType = columns.find((c) => c.name === target)?.type;
  const resolvedTask = task !== 'auto' ? task : targetType === 'float' ? 'regression' : targetType === 'integer' ? 'auto' : 'classification';
  const available = useMemo(() => (models.data ?? []).filter((m) => resolvedTask === 'auto' || m.tasks.includes(resolvedTask)), [models.data, resolvedTask]);
  useEffect(() => { if (available.length && !available.some((m) => m.type === model)) setModel(available[0].type); }, [available, model]);
  useEffect(() => { if (resolvedTask === 'regression' && strategy === 'stratified') setStrategy('random'); }, [resolvedTask, strategy]);

  const train = async () => {
    setRunning(true);
    setError('');
    setResult(null);
    setProgress({ stage: 'starting', progress: 0 });
    const config: ExperimentConfig = {
      target, features: features.filter((f) => f !== target), task, model, params,
      split: { strategy, testFraction, seed, groupBy: strategy === 'group' ? groupBy : undefined, timeColumn: strategy === 'time' ? timeColumn : undefined },
      cvFolds, search: search && SEARCH_PRESETS[model] ? { method: 'grid', space: SEARCH_PRESETS[model], maxTrials: 20 } : undefined, timeLimitSec: timeLimit, classWeight,
    };
    try {
      setResult(await api.invoke('ml.train', { versionId, config, name }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  return (
    <div className="wb-split-view dsm-app">
      <aside className="wb-side dsm-side dsm-trainer-side">
        <div className="dsm-pad">
          <h3>Train a model</h3>
          <label className="dsm-field"><span>Data</span><VersionPicker api={api} value={versionId} onChange={setVersionId} /></label>
          {columns.length > 0 && (
            <>
              <label className="dsm-field"><span>Target (what to predict)</span>
                <select className="wb-select" value={target} onChange={(e) => setTarget(e.target.value)}>{columns.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.type})</option>)}</select>
              </label>
              <label className="dsm-field"><span>Task</span>
                <select className="wb-select" value={task} onChange={(e) => setTask(e.target.value as ExperimentConfig['task'])}><option value="auto">Detect from target</option><option value="classification">Classification</option><option value="regression">Regression</option></select>
              </label>
              <fieldset className="dsm-features">
                <legend>Features ({features.filter((f) => f !== target).length})</legend>
                <div className="dsm-row"><button className="wb-link" onClick={() => setFeatures(columns.map((c) => c.name).filter((c) => c !== target))}>all</button><button className="wb-link" onClick={() => setFeatures([])}>none</button></div>
                {columns.filter((c) => c.name !== target).map((c) => (
                  <label key={c.name} className="dsm-check"><input type="checkbox" checked={features.includes(c.name)} onChange={(e) => setFeatures(e.target.checked ? [...features, c.name] : features.filter((f) => f !== c.name))} /> {c.name} <span className="dsm-muted">{c.type}</span></label>
                ))}
              </fieldset>
              <label className="dsm-field"><span>Model</span>
                <select className="wb-select" value={model} onChange={(e) => setModel(e.target.value as ExperimentConfig['model'])}>{available.map((m) => <option key={m.type} value={m.type}>{m.title}</option>)}</select>
              </label>
              {info && <p className="dsm-muted dsm-small">{info.note}</p>}
              {Object.entries(params).map(([k, v]) => (
                <label key={k} className="dsm-field dsm-param" title={PARAM_HELP[k]}><span>{k}</span>
                  {typeof v === 'string' ? <input className="wb-input" value={v} onChange={(e) => setParams({ ...params, [k]: e.target.value })} /> : <input className="wb-input" type="number" value={v} step="any" onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })} />}
                </label>
              ))}
              <details>
                <summary>Split and validation</summary>
                <label className="dsm-field"><span>Split</span>
                  <select className="wb-select" value={strategy} onChange={(e) => setStrategy(e.target.value as typeof strategy)}>
                    <option value="random">Random</option>
                    {resolvedTask !== 'regression' && <option value="stratified">Stratified by target</option>}
                    <option value="group">By group (no group on both sides)</option>
                    <option value="time">By time (train on earlier rows)</option>
                  </select>
                </label>
                {strategy === 'group' && <label className="dsm-field"><span>Group column</span><select className="wb-select" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}><option value="" />{columns.map((c) => <option key={c.name}>{c.name}</option>)}</select></label>}
                {strategy === 'time' && <label className="dsm-field"><span>Time column</span><select className="wb-select" value={timeColumn} onChange={(e) => setTimeColumn(e.target.value)}><option value="" />{columns.map((c) => <option key={c.name}>{c.name}</option>)}</select></label>}
                <label className="dsm-field"><span>Test share: {Math.round(testFraction * 100)}%</span><input type="range" min={0.05} max={0.5} step={0.05} value={testFraction} onChange={(e) => setTestFraction(Number(e.target.value))} /></label>
                <label className="dsm-field"><span>Seed</span><input className="wb-input" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} /></label>
                <label className="dsm-field"><span>Cross-validation folds (0 = off)</span><input className="wb-input" type="number" min={0} max={10} value={cvFolds} onChange={(e) => setCvFolds(Number(e.target.value))} /></label>
                <label className="dsm-check"><input type="checkbox" checked={search} onChange={(e) => setSearch(e.target.checked)} /> Tune hyperparameters (grid search with CV)</label>
                {resolvedTask !== 'regression' && (
                  <label className="dsm-field" title="Gives rare classes more weight. Used by logistic regression, boosting, neural network and SVM."><span>Class weights</span>
                    <select className="wb-select" value={classWeight} onChange={(e) => setClassWeight(e.target.value as 'none')}><option value="none">Equal</option><option value="balanced">Balanced (for imbalanced classes)</option></select>
                  </label>
                )}
                <label className="dsm-field"><span>Time limit (seconds)</span><input className="wb-input" type="number" min={5} max={1800} value={timeLimit} onChange={(e) => setTimeLimit(Number(e.target.value))} /></label>
              </details>
              <label className="dsm-field"><span>Run name (optional)</span><input className="wb-input" value={name} onChange={(e) => setName(e.target.value)} /></label>
              <div className="dsm-row">
                <button className="wb-btn primary" disabled={running || !target || !features.filter((f) => f !== target).length} onClick={train}>Train</button>
                {running && <button className="wb-btn" onClick={() => api.invoke('ml.cancel', {})}>Cancel</button>}
              </div>
            </>
          )}
        </div>
      </aside>
      <main className="wb-content dsm-main">
        <ErrorBox text={error || meta.error} />
        {running && progress && (
          <div className="dsm-progress" role="status">
            <span>{progress.stage}…</span>
            <progress max={1} value={progress.progress || undefined} />
          </div>
        )}
        {result ? (
          <>
            <div className="dsm-row">
              <h2 className="dsm-grow">Results</h2>
              <button className="wb-btn" onClick={() => api.openApp('data.experiments', result.runId)}>Open in Experiments</button>
            </div>
            <ResultsView r={result.result} />
          </>
        ) : !running && (
          <Empty>
            <h2>ML Trainer · Epoch</h2>
            <p>Pick a dataset, the column to predict and the features. Training runs inside AETHER on this PC with the built-in Epoch engine: no Python and no internet needed.</p>
            <p className="dsm-muted">Ten model families, from linear models to gradient-boosted trees and neural networks. Free-text columns become TF-IDF word features.</p>
            <p className="dsm-muted">Every run is checked for leakage first, compared with a baseline, and saved with the exact dataset version and settings so you can reproduce it.</p>
          </Empty>
        )}
      </main>
    </div>
  );
}
