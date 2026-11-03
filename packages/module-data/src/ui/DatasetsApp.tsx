import { useEffect, useMemo, useState } from 'react';
import type { ChartData, ChartKind } from '../charts.js';
import type { DatasetProfile } from '../profile.js';
import type { Step } from '../pipeline.js';
import type { DatasetComparison } from '../compare.js';
import type { CorrelationMatrix } from '../stats.js';
import { type Api, type ColumnSchema, type DatasetRow, type VersionRow, Chart, DataGrid, Empty, ErrorBox, Heatmap, MiniHistogram, Tabs, errText, fmt, looksLikeIdName, pct, useLoad } from './common.js';

type Tab = 'table' | 'profile' | 'clean' | 'charts' | 'compare' | 'details';

export function DatasetsApp({ api }: { api: Api }) {
  const list = useLoad<DatasetRow[]>(api, 'datasets.list', {}, []);
  const [datasetId, setDatasetId] = useState('');
  const versions = useLoad<VersionRow[]>(api, 'datasets.versions', datasetId ? { datasetId } : undefined, [datasetId]);
  const [versionId, setVersionId] = useState('');
  const [tab, setTab] = useState<Tab>('table');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [paste, setPaste] = useState<{ name: string; text: string } | null>(null);

  useEffect(() => {
    if (!datasetId && list.data?.length) setDatasetId(list.data[0].id);
  }, [list.data, datasetId]);
  useEffect(() => {
    const vs = versions.data;
    if (vs?.length && !vs.some((v) => v.id === versionId)) setVersionId(vs[vs.length - 1].id);
  }, [versions.data, versionId]);

  const meta = useLoad<{ version: VersionRow; dataset: DatasetRow; schema: { columns: ColumnSchema[]; rows: number } }>(api, 'version.get', versionId ? { versionId } : undefined, [versionId]);

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(label);
    setError('');
    try {
      return await fn();
    } catch (e) {
      setError(errText(e));
      return undefined;
    } finally {
      setBusy('');
    }
  }

  async function importFile() {
    const r = await run('Importing…', () => api.invoke<{ datasetId: string; version: VersionRow } | null>('datasets.import', {}));
    if (r) { list.reload(); setDatasetId(r.datasetId); setVersionId(r.version.id); setTab('profile'); }
  }
  async function importPaste() {
    if (!paste) return;
    const r = await run('Importing…', () => api.invoke<{ datasetId: string; version: VersionRow }>('datasets.importText', { name: paste.name || 'Pasted data', text: paste.text }));
    if (r) { setPaste(null); list.reload(); setDatasetId(r.datasetId); setVersionId(r.version.id); }
  }
  async function exportAs(format: 'csv' | 'json' | 'jsonl') {
    const path = await run('Exporting…', () => api.invoke<string | null>('version.export', { versionId, format }));
    if (path) setError('');
  }
  async function remove() {
    if (!datasetId || !window.confirm('Delete this dataset, all its versions and the experiment runs that used them?')) return;
    await run('Deleting…', () => api.invoke('datasets.delete', { datasetId }));
    setDatasetId('');
    setVersionId('');
    list.reload();
  }

  return (
    <div className="wb-split-view dsm-app">
      <aside className="wb-side dsm-side">
        <div className="dsm-side-actions">
          <button className="wb-btn primary" onClick={importFile} disabled={!!busy}>Open file…</button>
          <button className="wb-btn" onClick={() => setPaste({ name: '', text: '' })}>Paste</button>
        </div>
        {list.data?.length === 0 && <p className="dsm-muted dsm-pad">CSV, TSV, JSON, JSON Lines and Parquet files are supported. Data stays on this PC.</p>}
        {list.data?.map((d) => (
          <div key={d.id}>
            <button className={`wb-side-item${d.id === datasetId ? ' dsm-on' : ''}`} onClick={() => setDatasetId(d.id)}>
              <strong>{d.name}</strong>
              <span className="dsm-muted"> · {d.versions} version{d.versions === 1 ? '' : 's'}</span>
            </button>
            {d.id === datasetId && versions.data?.map((v) => (
              <button key={v.id} className={`wb-side-item dsm-version${v.id === versionId ? ' dsm-on' : ''}`} onClick={() => setVersionId(v.id)} title={`SHA-256 ${v.sha256}`}>
                {v.parentId ? '↳ ' : ''}{v.label} <span className="dsm-muted">{fmt(v.rows)}×{v.cols}</span>
              </button>
            ))}
          </div>
        ))}
      </aside>
      <main className="wb-content dsm-main">
        <ErrorBox text={error || list.error || meta.error} />
        {busy && <div className="dsm-busy">{busy}</div>}
        {!versionId || !meta.data ? (
          <Empty>
            <h2>Datasets</h2>
            <p>Open a data file to see its schema, profile, charts and to clean it into new versions. The original file is never changed.</p>
          </Empty>
        ) : (
          <>
            <header className="dsm-head">
              <div>
                <h2>{meta.data.dataset.name}</h2>
                <div className="dsm-muted">{meta.data.version.label} · {fmt(meta.data.version.rows)} rows × {meta.data.version.cols} columns · {meta.data.version.format.toUpperCase()}{meta.data.version.truncated ? ' · partial load' : ''}</div>
              </div>
              <div className="dsm-row">
                <select className="wb-select" aria-label="Export format" value="" onChange={(e) => e.target.value && exportAs(e.target.value as 'csv')}>
                  <option value="">Export…</option>
                  <option value="csv">CSV</option>
                  <option value="json">JSON</option>
                  <option value="jsonl">JSON Lines</option>
                </select>
                <button className="wb-btn" onClick={() => api.openApp('data.trainer', versionId)}>Train a model</button>
                <button className="wb-btn danger" onClick={remove}>Delete</button>
              </div>
            </header>
            <Tabs value={tab} onChange={setTab} options={[['table', 'Table'], ['profile', 'Profile'], ['clean', 'Clean'], ['charts', 'Charts'], ['compare', 'Compare'], ['details', 'Provenance']]} />
            <div className="dsm-tabbody">
              {tab === 'table' && <TableTab api={api} versionId={versionId} rows={meta.data.version.rows} />}
              {tab === 'profile' && <ProfileTab api={api} versionId={versionId} />}
              {tab === 'clean' && <CleanTab api={api} versionId={versionId} schema={meta.data.schema.columns} onSaved={(v) => { versions.reload(); list.reload(); setVersionId(v.id); setTab('table'); }} />}
              {tab === 'charts' && <ChartsTab api={api} versionId={versionId} schema={meta.data.schema.columns} />}
              {tab === 'compare' && <CompareTab api={api} versionId={versionId} versions={versions.data ?? []} schema={meta.data.schema.columns} />}
              {tab === 'details' && <DetailsTab api={api} dataset={meta.data.dataset} version={meta.data.version} versions={versions.data ?? []} onSaved={list.reload} />}
            </div>
          </>
        )}
      </main>
      {paste && (
        <div className="wb-modal-back" onClick={() => setPaste(null)}>
          <div className="wb-modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>Paste data</h3>
            <input className="wb-input" placeholder="Name" value={paste.name} onChange={(e) => setPaste({ ...paste, name: e.target.value })} />
            <textarea className="wb-input dsm-code" rows={12} placeholder="CSV, TSV or JSON" aria-label="Data" value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} />
            <div className="dsm-row"><button className="wb-btn primary" disabled={!paste.text.trim()} onClick={importPaste}>Import</button><button className="wb-btn" onClick={() => setPaste(null)}>Cancel</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

function TableTab({ api, versionId, rows }: { api: Api; versionId: string; rows: number }) {
  const [start, setStart] = useState(0);
  const size = 100;
  useEffect(() => setStart(0), [versionId]);
  const page = useLoad<{ columns: string[]; rows: unknown[][] }>(api, 'version.rows', { versionId, start, count: size }, [versionId, start]);
  return (
    <div>
      <div className="dsm-row dsm-pager">
        <button className="wb-btn small" disabled={start === 0} onClick={() => setStart(Math.max(0, start - size))}>‹ Prev</button>
        <span className="dsm-muted">Rows {fmt(Math.min(rows, start + 1))}–{fmt(Math.min(rows, start + size))} of {fmt(rows)}</span>
        <button className="wb-btn small" disabled={start + size >= rows} onClick={() => setStart(start + size)}>Next ›</button>
      </div>
      <ErrorBox text={page.error} />
      {page.data && <DataGrid columns={page.data.columns} rows={page.data.rows} start={start} />}
    </div>
  );
}

function ProfileTab({ api, versionId }: { api: Api; versionId: string }) {
  const p = useLoad<DatasetProfile>(api, 'version.profile', { versionId }, [versionId]);
  if (p.loading && !p.data) return <div className="dsm-muted">Profiling…</div>;
  if (!p.data) return <ErrorBox text={p.error} />;
  const d = p.data;
  const risk = d.warnings.filter((w) => w.level === 'risk');
  return (
    <div className="dsm-profile">
      <div className="dsm-stats">
        <div className="wb-card"><b>{fmt(d.rows)}</b><span>rows</span></div>
        <div className="wb-card"><b>{d.columns}</b><span>columns</span></div>
        <div className="wb-card"><b>{pct(d.missingCells / Math.max(1, d.rows * d.columns))}</b><span>cells missing</span></div>
        <div className="wb-card"><b>{fmt(d.duplicateRows)}</b><span>duplicate rows</span></div>
        <div className="wb-card"><b>{fmt(d.approxBytes / 1048576, 1)} MB</b><span>in memory (approx.)</span></div>
      </div>
      {risk.length > 0 && <div className="dsm-warnbox risk"><b>Possible sensitive data.</b> {risk.length} column{risk.length > 1 ? 's' : ''} may hold personal data or secrets. Check before sharing or sending to a cloud service.</div>}
      {d.warnings.length > 0 && (
        <details open={d.warnings.length < 12} className="dsm-warnings">
          <summary>{d.warnings.length} findings</summary>
          <ul>{d.warnings.map((w, i) => <li key={i} className={`dsm-${w.level}`}>{w.message}</li>)}</ul>
        </details>
      )}
      <table className="wb-table">
        <thead><tr><th>Column</th><th>Type</th><th>Missing</th><th>Distinct</th><th>Summary</th><th>Distribution / top values</th></tr></thead>
        <tbody>
          {d.profiles.map((c) => (
            <tr key={c.name}>
              <td><b>{c.name}</b></td>
              <td>{c.schema.type}{c.schema.confidence < 1 ? <span className="dsm-muted"> ({pct(c.schema.confidence)})</span> : null}</td>
              <td>{c.missing ? `${fmt(c.missing)} (${pct(c.missingPct)})` : '0'}</td>
              <td>{fmt(c.distinct)}</td>
              <td className="dsm-small">
                {c.numeric ? <>min {fmt(c.numeric.min)} · median {fmt(c.numeric.median)} · max {fmt(c.numeric.max)}<br />mean {fmt(c.numeric.mean)} · sd {fmt(c.numeric.std)}</> : c.dates ? <>{c.dates.min.slice(0, 10)} → {c.dates.max.slice(0, 10)}</> : c.text ? <>length {c.text.minLength}–{c.text.maxLength}</> : null}
              </td>
              <td>{c.histogram ? <MiniHistogram counts={c.histogram.counts} /> : <span className="dsm-small">{c.top.slice(0, 4).map((t) => `${t.value.slice(0, 20)} (${t.count})`).join(', ')}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STEP_LABELS: Record<Step['op'], string> = {
  filter: 'Filter rows', derive: 'New column (formula)', select: 'Keep columns', drop: 'Drop columns', rename: 'Rename column', sort: 'Sort', cast: 'Change type', fillMissing: 'Fill missing values', dropMissing: 'Drop rows with missing values', dedupe: 'Remove duplicate rows', trim: 'Trim spaces', replace: 'Replace value', clipOutliers: 'Clip outliers', scale: 'Scale column', oneHot: 'One-hot encode', groupBy: 'Group and aggregate', sample: 'Random sample', limit: 'First N rows', kmeans: 'Cluster rows (k-means)', pca: 'Reduce dimensions (PCA)',
};

function defaultStep(op: Step['op'], col: string): Step {
  switch (op) {
    case 'filter': return { op, expr: `notnull(\`${col}\`)` };
    case 'derive': return { op, name: 'new_column', expr: `\`${col}\`` };
    case 'select': return { op, columns: [col] };
    case 'drop': return { op, columns: [col] };
    case 'rename': return { op, from: col, to: `${col}_renamed` };
    case 'sort': return { op, by: [{ column: col, desc: false }] };
    case 'cast': return { op, column: col, type: 'float' };
    case 'fillMissing': return { op, column: col, strategy: 'median' };
    case 'dropMissing': return { op };
    case 'dedupe': return { op };
    case 'trim': return { op };
    case 'replace': return { op, column: col, from: '', to: null };
    case 'clipOutliers': return { op, column: col, method: 'iqr' };
    case 'scale': return { op, column: col, method: 'standard' };
    case 'oneHot': return { op, column: col };
    case 'groupBy': return { op, by: [col], aggs: [{ column: col, agg: 'count' }] };
    case 'sample': return { op, n: 1000, seed: 42 };
    case 'limit': return { op, n: 1000 };
    case 'kmeans': return { op, columns: [col], k: 3, seed: 42 };
    case 'pca': return { op, columns: [col], components: 2 };
  }
}

function StepEditor({ step, columns, onChange }: { step: Step; columns: string[]; onChange: (s: Step) => void }) {
  const colSel = (value: string, set: (v: string) => void, label = 'Column') => (
    <select className="wb-select" aria-label={label} value={value} onChange={(e) => set(e.target.value)}>{columns.map((c) => <option key={c}>{c}</option>)}</select>
  );
  const multi = (value: string[] | undefined, set: (v: string[]) => void) => (
    <input className="wb-input dsm-grow" aria-label="Columns" placeholder="all columns (or comma-separated names)" value={(value ?? []).join(', ')} onChange={(e) => set(e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} />
  );
  switch (step.op) {
    case 'filter': return <input className="wb-input dsm-grow dsm-code" aria-label="Condition" value={step.expr} onChange={(e) => onChange({ ...step, expr: e.target.value })} />;
    case 'derive': return <><input className="wb-input" aria-label="Name" value={step.name} onChange={(e) => onChange({ ...step, name: e.target.value })} /> = <input className="wb-input dsm-grow dsm-code" aria-label="Formula" value={step.expr} onChange={(e) => onChange({ ...step, expr: e.target.value })} /></>;
    case 'select': case 'drop': return multi(step.columns, (columns) => onChange({ ...step, columns }));
    case 'dropMissing': case 'dedupe': case 'trim': return multi(step.columns, (c) => onChange({ ...step, columns: c.length ? c : undefined }));
    case 'rename': return <>{colSel(step.from, (from) => onChange({ ...step, from }))} → <input className="wb-input" aria-label="New name" value={step.to} onChange={(e) => onChange({ ...step, to: e.target.value })} /></>;
    case 'sort': return <>{colSel(step.by[0]?.column ?? '', (column) => onChange({ ...step, by: [{ column, desc: step.by[0]?.desc }] }))}<label><input type="checkbox" checked={!!step.by[0]?.desc} onChange={(e) => onChange({ ...step, by: [{ column: step.by[0]?.column ?? columns[0], desc: e.target.checked }] })} /> descending</label></>;
    case 'cast': return <>{colSel(step.column, (column) => onChange({ ...step, column }))}<select className="wb-select" aria-label="Type" value={step.type} onChange={(e) => onChange({ ...step, type: e.target.value as typeof step.type })}>{['integer', 'float', 'boolean', 'date', 'datetime', 'categorical', 'text'].map((t) => <option key={t}>{t}</option>)}</select></>;
    case 'fillMissing': return <>{colSel(step.column, (column) => onChange({ ...step, column }))}<select className="wb-select" aria-label="Strategy" value={step.strategy} onChange={(e) => onChange({ ...step, strategy: e.target.value as typeof step.strategy })}>{['mean', 'median', 'mode', 'constant', 'ffill', 'bfill'].map((t) => <option key={t}>{t}</option>)}</select>{step.strategy === 'constant' && <input className="wb-input" aria-label="Value" value={String(step.value ?? '')} onChange={(e) => onChange({ ...step, value: e.target.value })} />}</>;
    case 'replace': return <>{colSel(step.column, (column) => onChange({ ...step, column }))}<input className="wb-input" aria-label="Find" value={String(step.from ?? '')} onChange={(e) => onChange({ ...step, from: e.target.value })} /> → <input className="wb-input" aria-label="Replace with" placeholder="(missing)" value={String(step.to ?? '')} onChange={(e) => onChange({ ...step, to: e.target.value === '' ? null : e.target.value })} /></>;
    case 'clipOutliers': return <>{colSel(step.column, (column) => onChange({ ...step, column }))}<select className="wb-select" aria-label="Method" value={step.method} onChange={(e) => onChange({ ...step, method: e.target.value as 'iqr' })}><option value="iqr">1.5 × IQR</option><option value="percentile">1st–99th percentile</option></select></>;
    case 'scale': return <>{colSel(step.column, (column) => onChange({ ...step, column }))}<select className="wb-select" aria-label="Method" value={step.method} onChange={(e) => onChange({ ...step, method: e.target.value as 'standard' })}><option value="standard">standardise (z-score)</option><option value="minmax">min–max to 0–1</option></select></>;
    case 'oneHot': return colSel(step.column, (column) => onChange({ ...step, column }));
    case 'groupBy': return <>by {colSel(step.by[0] ?? '', (c) => onChange({ ...step, by: [c] }), 'Group by')}<select className="wb-select" aria-label="Aggregate" value={step.aggs[0]?.agg} onChange={(e) => onChange({ ...step, aggs: [{ column: step.aggs[0]?.column ?? columns[0], agg: e.target.value as 'sum' }] })}>{['count', 'sum', 'mean', 'median', 'min', 'max', 'std', 'nunique', 'first'].map((a) => <option key={a}>{a}</option>)}</select> of {colSel(step.aggs[0]?.column ?? '', (column) => onChange({ ...step, aggs: [{ column, agg: step.aggs[0]?.agg ?? 'count' }] }), 'Aggregate column')}</>;
    case 'sample': return <><input className="wb-input" type="number" aria-label="Rows" value={step.n ?? ''} onChange={(e) => onChange({ ...step, n: Number(e.target.value) })} /> rows, seed <input className="wb-input dsm-narrow" type="number" aria-label="Seed" value={step.seed} onChange={(e) => onChange({ ...step, seed: Number(e.target.value) })} /></>;
    case 'limit': return <input className="wb-input" type="number" aria-label="Rows" value={step.n} onChange={(e) => onChange({ ...step, n: Number(e.target.value) })} />;
    case 'kmeans': return <>{multi(step.columns, (c) => onChange({ ...step, columns: c }))} k <input className="wb-input dsm-narrow" type="number" min={2} max={50} aria-label="Clusters" value={step.k} onChange={(e) => onChange({ ...step, k: Number(e.target.value) })} /> seed <input className="wb-input dsm-narrow" type="number" aria-label="Seed" value={step.seed} onChange={(e) => onChange({ ...step, seed: Number(e.target.value) })} /> → <input className="wb-input dsm-narrow" aria-label="Output column" placeholder="cluster" value={step.as ?? ''} onChange={(e) => onChange({ ...step, as: e.target.value || undefined })} /></>;
    case 'pca': return <>{multi(step.columns, (c) => onChange({ ...step, columns: c }))} components <input className="wb-input dsm-narrow" type="number" min={1} max={20} aria-label="Components" value={step.components} onChange={(e) => onChange({ ...step, components: Number(e.target.value) })} /></>;
  }
}

function CleanTab({ api, versionId, schema, onSaved }: { api: Api; versionId: string; schema: ColumnSchema[]; onSaved: (v: VersionRow) => void }) {
  const [steps, setSteps] = useState<Step[]>([]);
  const [preview, setPreview] = useState<{ columns: string[]; rows: unknown[][]; reports: VersionRow['reports'] } | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const columns = schema.map((c) => c.name);
  const [addOp, setAddOp] = useState<Step['op']>('filter');
  useEffect(() => { setSteps([]); setPreview(null); setCode(''); }, [versionId]);
  useEffect(() => {
    if (!steps.length) { setPreview(null); setError(''); return; }
    const h = setTimeout(() => {
      api.invoke<typeof preview>('pipeline.preview', { versionId, steps }).then((p) => { setPreview(p); setError(''); }, (e) => setError(errText(e)));
    }, 300);
    return () => clearTimeout(h);
  }, [api, versionId, steps]);
  const save = async () => {
    try {
      onSaved(await api.invoke<VersionRow>('pipeline.apply', { versionId, steps, label }));
    } catch (e) {
      setError(errText(e));
    }
  };
  return (
    <div className="dsm-clean">
      <p className="dsm-muted">Steps run in order on this version and are saved as a new version; the original stays as it is. Formulas use column names (wrap names with spaces in `backticks`), + − × ÷, comparisons, and/or/not, and functions such as lower(), isnull(), if(), round(), log(), year().</p>
      <ol className="dsm-steps">
        {steps.map((s, i) => (
          <li key={i} className="wb-card">
            <span className="dsm-step-title">{STEP_LABELS[s.op]}</span>
            <span className="dsm-row dsm-grow"><StepEditor step={s} columns={columns} onChange={(n) => setSteps(steps.map((x, j) => (j === i ? n : x)))} /></span>
            {preview?.reports[i] && <span className="dsm-muted dsm-small">{fmt(preview.reports[i].rowsIn)} → {fmt(preview.reports[i].rowsOut)} rows{preview.reports[i].note ? ` · ${preview.reports[i].note}` : ''}</span>}
            <button className="wb-icon danger" aria-label="Remove step" onClick={() => setSteps(steps.filter((_, j) => j !== i))}>✕</button>
          </li>
        ))}
      </ol>
      <div className="dsm-row">
        <select className="wb-select" aria-label="Step type" value={addOp} onChange={(e) => setAddOp(e.target.value as Step['op'])}>{Object.entries(STEP_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <button className="wb-btn" disabled={!columns.length} onClick={() => setSteps([...steps, defaultStep(addOp, columns[0])])}>Add step</button>
        <span className="dsm-grow" />
        <button className="wb-btn" onClick={async () => setCode(await api.invoke<string>('pipeline.pandas', { versionId, steps }))}>Show as pandas code</button>
        <input className="wb-input" placeholder="Version name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="wb-btn primary" disabled={!steps.length || !!error} onClick={save}>Save as new version</button>
      </div>
      <ErrorBox text={error} />
      {code && <pre className="dsm-code-block">{code}</pre>}
      {preview && <><h4>Preview (first 200 rows)</h4><DataGrid columns={preview.columns} rows={preview.rows} /></>}
    </div>
  );
}

function ChartsTab({ api, versionId, schema }: { api: Api; versionId: string; schema: ColumnSchema[] }) {
  const numeric = schema.filter((c) => c.type === 'integer' || c.type === 'float').map((c) => c.name);
  const preferred = numeric.filter((c) => !looksLikeIdName(c));
  const all = schema.map((c) => c.name);
  const [kind, setKind] = useState<ChartKind>('histogram');
  const [x, setX] = useState(preferred[0] ?? numeric[0] ?? all[0] ?? '');
  const [y, setY] = useState(preferred[1] ?? numeric[1] ?? numeric[0] ?? '');
  const [group, setGroup] = useState('');
  const [agg, setAgg] = useState<'count' | 'sum' | 'mean'>('count');
  const request = useMemo(() => (x ? { versionId, request: { kind, x, y: kind === 'line' || kind === 'scatter' || (kind === 'bar' && agg !== 'count') ? y : undefined, group: kind === 'scatter' || kind === 'box' ? group || undefined : undefined, agg } } : undefined), [versionId, kind, x, y, group, agg]);
  const chart = useLoad<ChartData>(api, 'version.chart', request, [JSON.stringify(request)]);
  const [corrMethod, setCorrMethod] = useState<'pearson' | 'spearman'>('pearson');
  const corr = useLoad<CorrelationMatrix>(api, 'version.correlation', numeric.length >= 2 ? { versionId, columns: numeric.slice(0, 30), method: corrMethod } : undefined, [versionId, corrMethod, numeric.length]);
  const sel = (v: string, set: (v: string) => void, label: string, opts: string[], blank?: string) => <label className="dsm-field"><span>{label}</span><select className="wb-select" value={v} onChange={(e) => set(e.target.value)}>{blank !== undefined && <option value="">{blank}</option>}{opts.map((c) => <option key={c}>{c}</option>)}</select></label>;
  return (
    <div>
      <div className="dsm-row dsm-wrap">
        {sel(kind, (v) => setKind(v as ChartKind), 'Chart', ['histogram', 'bar', 'line', 'scatter', 'box'])}
        {sel(x, setX, kind === 'bar' ? 'Category' : kind === 'box' ? 'Value' : 'X', kind === 'histogram' || kind === 'box' ? numeric : all)}
        {kind === 'bar' && sel(agg, (v) => setAgg(v as 'count'), 'Measure', ['count', 'sum', 'mean'])}
        {(kind === 'line' || kind === 'scatter' || (kind === 'bar' && agg !== 'count')) && sel(y, setY, 'Y', numeric)}
        {(kind === 'scatter' || kind === 'box') && sel(group, setGroup, 'Colour / group by', all, '(none)')}
      </div>
      <ErrorBox text={chart.error} />
      {chart.data && <Chart data={chart.data} />}
      {corr.data && (
        <section>
          <div className="dsm-row"><h4>Correlation</h4>{sel(corrMethod, (v) => setCorrMethod(v as 'pearson'), 'Method', ['pearson', 'spearman'])}</div>
          <Heatmap title="Correlation matrix" rows={corr.data.columns} cols={corr.data.columns} values={corr.data.values} diverging />
          <p className="dsm-muted dsm-small">Correlation shows linear (Pearson) or rank (Spearman) association only, not cause and effect.</p>
        </section>
      )}
    </div>
  );
}

function CompareTab({ api, versionId, versions, schema }: { api: Api; versionId: string; versions: VersionRow[]; schema: ColumnSchema[] }) {
  const others = versions.filter((v) => v.id !== versionId);
  const [other, setOther] = useState(others[0]?.id ?? '');
  const [key, setKey] = useState('');
  useEffect(() => { if (!others.some((o) => o.id === other)) setOther(others[0]?.id ?? ''); }, [others, other]);
  const cmp = useLoad<DatasetComparison>(api, 'version.compare', other ? { a: other, b: versionId, key: key ? [key] : undefined } : undefined, [other, versionId, key]);
  if (!others.length) return <Empty>Only one version. Clean the data or import another version to compare.</Empty>;
  return (
    <div>
      <div className="dsm-row dsm-wrap">
        <label className="dsm-field"><span>Compare this version with</span><select className="wb-select" value={other} onChange={(e) => setOther(e.target.value)}>{others.map((v) => <option key={v.id} value={v.id}>{v.label} ({fmt(v.rows)} rows)</option>)}</select></label>
        <label className="dsm-field"><span>Match rows by key (optional)</span><select className="wb-select" value={key} onChange={(e) => setKey(e.target.value)}><option value="">(no key)</option>{schema.map((c) => <option key={c.name}>{c.name}</option>)}</select></label>
      </div>
      <ErrorBox text={cmp.error} />
      {cmp.data && (
        <>
          <p>Rows: {fmt(cmp.data.rowsA)} → {fmt(cmp.data.rowsB)}</p>
          {cmp.data.schema.length > 0 && <ul>{cmp.data.schema.map((s) => <li key={s.column + s.change}>{s.change === 'added' ? `Added “${s.column}” (${s.to})` : s.change === 'removed' ? `Removed “${s.column}”` : `“${s.column}” changed from ${s.from} to ${s.to}`}</li>)}</ul>}
          {cmp.data.rows && <p>By “{key}”: {fmt(cmp.data.rows.added)} added, {fmt(cmp.data.rows.removed)} removed, {fmt(cmp.data.rows.changed)} changed, {fmt(cmp.data.rows.unchanged)} unchanged{cmp.data.rows.duplicateKeysA + cmp.data.rows.duplicateKeysB ? ` (duplicate keys ignored: ${cmp.data.rows.duplicateKeysA + cmp.data.rows.duplicateKeysB})` : ''}.</p>}
          <table className="wb-table">
            <thead><tr><th>Column</th><th>Kind</th><th>Mean before → after</th><th>Std. shift</th><th>PSI</th><th>Drift</th></tr></thead>
            <tbody>{cmp.data.drift.map((d) => <tr key={d.column}><td>{d.column}</td><td>{d.kind}</td><td>{d.meanA !== undefined ? `${fmt(d.meanA)} → ${fmt(d.meanB)}` : '—'}</td><td>{fmt(d.standardizedShift, 2)}</td><td>{fmt(d.psi, 3)}</td><td className={`dsm-drift-${d.level}`}>{d.level}</td></tr>)}</tbody>
          </table>
          <p className="dsm-muted dsm-small">PSI below 0.1 is usually read as stable and above 0.25 as a large shift; these are rules of thumb, not tests.</p>
        </>
      )}
    </div>
  );
}

function DetailsTab({ api, dataset, version, versions, onSaved }: { api: Api; dataset: DatasetRow; version: VersionRow; versions: VersionRow[]; onSaved: () => void }) {
  const [form, setForm] = useState(dataset);
  const [saved, setSaved] = useState('');
  useEffect(() => setForm(dataset), [dataset]);
  const save = async () => {
    await api.invoke('datasets.update', { datasetId: dataset.id, name: form.name, licence: form.licence, source: form.source, citation: form.citation, notes: form.notes });
    setSaved('Saved');
    onSaved();
  };
  const chain: VersionRow[] = [];
  for (let v: VersionRow | undefined = version; v; v = versions.find((x) => x.id === v!.parentId)) chain.unshift(v);
  return (
    <div className="dsm-details">
      <div className="wb-form dsm-form">
        <label>Name<input className="wb-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label>Source (URL or description)<input className="wb-input" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} /></label>
        <label>Licence<input className="wb-input" list="dsm-licences" placeholder="e.g. CC-BY-4.0" value={form.licence} onChange={(e) => setForm({ ...form, licence: e.target.value })} /></label>
        <datalist id="dsm-licences">{['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'ODbL-1.0', 'PDDL-1.0', 'MIT', 'Proprietary', 'Unknown'].map((l) => <option key={l} value={l} />)}</datalist>
        <label>How to cite<textarea className="wb-input" rows={2} value={form.citation} onChange={(e) => setForm({ ...form, citation: e.target.value })} /></label>
        <label>Notes<textarea className="wb-input" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        <div className="dsm-row"><button className="wb-btn primary" onClick={save}>Save details</button><span className="dsm-muted">{saved}</span></div>
      </div>
      <h4>Lineage of this version</h4>
      <ol className="dsm-lineage">
        {chain.map((v) => (
          <li key={v.id}>
            <b>{v.label}</b> <span className="dsm-muted">{v.createdAt.replace('T', ' ').slice(0, 19)} · {fmt(v.rows)} × {v.cols}</span>
            <div className="dsm-mono dsm-small">SHA-256 {v.sha256}</div>
            {v.sourcePath && <div className="dsm-small">From {v.sourcePath}</div>}
            {v.notes.map((n, i) => <div key={i} className="dsm-small dsm-muted">{n}</div>)}
            {v.reports.map((r, i) => <div key={i} className="dsm-small">· {r.op}: {fmt(r.rowsIn)} → {fmt(r.rowsOut)} rows{r.note ? ` (${r.note})` : ''}</div>)}
          </li>
        ))}
      </ol>
    </div>
  );
}
