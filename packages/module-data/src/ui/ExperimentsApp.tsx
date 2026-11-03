import { useEffect, useState } from 'react';
import { type Api, Empty, ErrorBox, VersionPicker, errText, fmt, useLoad } from './common.js';
import { ResultsView, type ResultSummary } from './Results.js';

interface RunRow { id: string; versionId: string; name: string; createdAt: string; task: string; model: string; metricName: string; metricValue: number | null; baselineValue: number | null; durationMs: number; notes: string; imported: boolean }
type RunDetail = RunRow & { config: { target?: string; features?: string[] }; result: Partial<ResultSummary> & { imported?: boolean } };

export function ExperimentsApp({ api }: { api: Api }) {
  const runs = useLoad<RunRow[]>(api, 'runs.list', {}, []);
  const [selected, setSelected] = useState(api.arg && /^[0-9a-f-]{36}$/.test(api.arg) ? api.arg : '');
  const [compare, setCompare] = useState<string[]>([]);
  const detail = useLoad<RunDetail>(api, 'runs.get', selected ? { runId: selected } : undefined, [selected]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [report, setReport] = useState('');
  const [notes, setNotes] = useState('');
  const [importVersion, setImportVersion] = useState('');
  useEffect(() => { setNotes(detail.data?.notes ?? ''); setReport(''); setStatus(''); }, [detail.data]);
  useEffect(() => { if (!selected && runs.data?.length) setSelected(runs.data[0].id); }, [runs.data, selected]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError('');
    try {
      const r = await fn();
      if (done) setStatus(done);
      return r;
    } catch (e) {
      setError(errText(e));
      return undefined;
    }
  };

  const toWriter = async () => {
    const md = report || (await api.invoke<string>('runs.report', { runId: selected }));
    const doc = await act(() => api.invokeModule<{ id: string }>('aether.writer', 'createFromMarkdown', { title: `Experiment: ${detail.data?.name}`, markdown: md }));
    if (doc && typeof doc === 'object' && 'id' in doc) api.openApp('writer', (doc as { id: string }).id);
  };

  const cmpRuns = (runs.data ?? []).filter((r) => compare.includes(r.id));

  return (
    <div className="wb-split-view dsm-app">
      <aside className="wb-side dsm-side">
        <div className="dsm-pad">
          <h3>Experiments</h3>
          <details>
            <summary>Import a model file</summary>
            <p className="dsm-small dsm-muted">Attach it to a dataset version so you can run predictions. The file is checked before use.</p>
            <VersionPicker api={api} value={importVersion} onChange={setImportVersion} />
            <button className="wb-btn" disabled={!importVersion} onClick={async () => { const id = await act(() => api.invoke<string | null>('model.import', { versionId: importVersion })); if (typeof id === 'string') { runs.reload(); setSelected(id); } }}>Choose file…</button>
          </details>
        </div>
        {runs.data?.length === 0 && <p className="dsm-muted dsm-pad">No runs yet. Train a model in the ML Trainer.</p>}
        {runs.data?.map((r) => (
          <div key={r.id} className={`dsm-run${r.id === selected ? ' dsm-on' : ''}`}>
            <input type="checkbox" aria-label={`Compare ${r.name}`} checked={compare.includes(r.id)} onChange={(e) => setCompare(e.target.checked ? [...compare, r.id] : compare.filter((x) => x !== r.id))} />
            <button className="wb-side-item" onClick={() => setSelected(r.id)}>
              <strong>{r.name}</strong>
              <div className="dsm-small dsm-muted">{r.metricValue !== null ? `${r.metricName} ${fmt(r.metricValue, 3)} (baseline ${fmt(r.baselineValue, 3)})` : r.imported ? 'imported model' : '—'} · {r.createdAt.slice(0, 16).replace('T', ' ')}</div>
            </button>
          </div>
        ))}
      </aside>
      <main className="wb-content dsm-main">
        <ErrorBox text={error || runs.error || detail.error} />
        {status && <div className="dsm-ok">{status}</div>}
        {cmpRuns.length >= 2 && (
          <section className="wb-card">
            <div className="dsm-row"><h3 className="dsm-grow">Comparing {cmpRuns.length} runs</h3><button className="wb-btn small" onClick={() => setCompare([])}>Clear</button></div>
            <table className="wb-table">
              <thead><tr><th>Run</th><th>Model</th><th>Task</th><th>Score</th><th>Baseline</th><th>Gain</th><th>Time</th></tr></thead>
              <tbody>
                {[...cmpRuns].sort((a, b) => (b.metricValue ?? -Infinity) - (a.metricValue ?? -Infinity)).map((r, i) => (
                  <tr key={r.id} className={i === 0 ? 'dsm-best' : ''}>
                    <td>{r.name}</td><td>{r.model}</td><td>{r.task}</td>
                    <td>{r.metricName} {fmt(r.metricValue, 4)}</td><td>{fmt(r.baselineValue, 4)}</td>
                    <td>{r.metricValue !== null && r.baselineValue !== null ? fmt(r.metricValue - r.baselineValue, 4) : '—'}</td>
                    <td>{(r.durationMs / 1000).toFixed(1)} s</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {new Set(cmpRuns.map((r) => r.versionId)).size > 1 && <p className="dsm-warn dsm-small">These runs used different dataset versions, so their scores are not directly comparable.</p>}
            {new Set(cmpRuns.map((r) => r.metricName)).size > 1 && <p className="dsm-warn dsm-small">These runs use different metrics.</p>}
          </section>
        )}
        {!detail.data ? (
          <Empty><h2>Experiments</h2><p>Every training run is saved here with its dataset version, settings and results. Tick runs to compare them.</p></Empty>
        ) : (
          <>
            <header className="dsm-head">
              <div><h2>{detail.data.name}</h2><div className="dsm-muted">{detail.data.model} · {detail.data.task} · {detail.data.createdAt.replace('T', ' ').slice(0, 19)}</div></div>
              <div className="dsm-row dsm-wrap">
                {!detail.data.imported && <button className="wb-btn" onClick={async () => setReport((await act(() => api.invoke<string>('runs.report', { runId: selected }))) as string ?? '')}>Report</button>}
                {!detail.data.imported && <button className="wb-btn" onClick={toWriter}>Open report in Writer</button>}
                {!detail.data.imported && <button className="wb-btn" onClick={async () => setReport((await act(() => api.invoke<string>('runs.sklearn', { runId: selected }))) as string ?? '')}>Python (scikit-learn)</button>}
                <button className="wb-btn" onClick={() => act(() => api.invoke('model.export', { runId: selected }), 'Model exported.')}>Export model</button>
                <button className="wb-btn danger" onClick={async () => { if (window.confirm('Delete this run and its model?')) { await act(() => api.invoke('runs.delete', { runId: selected })); setSelected(''); runs.reload(); } }}>Delete</button>
              </div>
            </header>
            <label className="dsm-field"><span>Notes</span><textarea className="wb-input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== detail.data!.notes && act(() => api.invoke('runs.update', { runId: selected, notes }), 'Notes saved.')} /></label>
            {report && <pre className="dsm-code-block">{report}</pre>}
            <PredictPanel api={api} run={detail.data} onNewVersion={() => setStatus('Predictions saved as a new dataset version (see Datasets).')} />
            {detail.data.result.metrics ? <ResultsView r={detail.data.result as ResultSummary} /> : <p className="dsm-muted">Imported model: no evaluation results are stored with it. Predictions above use the file as imported.</p>}
          </>
        )}
      </main>
    </div>
  );
}

function PredictPanel({ api, run, onNewVersion }: { api: Api; run: RunDetail; onNewVersion: () => void }) {
  const inputs = run.config.features ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [out, setOut] = useState<{ prediction: unknown; proba?: Record<string, number> } | null>(null);
  const [versionId, setVersionId] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { setValues({}); setOut(null); }, [run.id]);
  const predict = async () => {
    setError('');
    try {
      const row: Record<string, string | number | null> = {};
      for (const k of inputs) { const v = values[k]?.trim() ?? ''; row[k] = v === '' ? null : !Number.isNaN(Number(v)) ? Number(v) : v; }
      const r = await api.invoke<{ predictions: Array<{ prediction: unknown; proba?: Record<string, number> }> }>('model.predict', { runId: run.id, rows: [row] });
      setOut(r.predictions[0]);
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <details className="wb-card dsm-predict">
      <summary>Try the model (inference)</summary>
      <div className="dsm-predict-grid">
        {inputs.map((k) => <label key={k} className="dsm-field"><span>{k}</span><input className="wb-input" placeholder="(missing)" value={values[k] ?? ''} onChange={(e) => setValues({ ...values, [k]: e.target.value })} /></label>)}
      </div>
      <div className="dsm-row"><button className="wb-btn primary" onClick={predict}>Predict</button>{out && <b>→ {fmt(out.prediction)}</b>}</div>
      {out?.proba && <div className="dsm-small">{Object.entries(out.proba).sort((a, b) => b[1] - a[1]).map(([k, p]) => `${k}: ${(p * 100).toFixed(1)}%`).join(' · ')}</div>}
      <p className="dsm-small dsm-muted">Blank fields are treated as missing and filled the same way as in training.</p>
      <div className="dsm-row">
        <span>Predict a whole dataset:</span>
        <VersionPicker api={api} value={versionId} onChange={setVersionId} />
        <button className="wb-btn" disabled={!versionId} onClick={async () => { setError(''); try { await api.invoke('model.predictVersion', { runId: run.id, versionId }); onNewVersion(); } catch (e) { setError(errText(e)); } }}>Run</button>
      </div>
      <ErrorBox text={error} />
    </details>
  );
}
