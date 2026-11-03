import { lazy, Suspense, useCallback, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { WorkbenchAppApi } from '@aether/plugin-api';
import type { ChartData } from '../charts.js';

export type Api = WorkbenchAppApi;

export function lazyApp(load: () => Promise<ComponentType<{ api: Api }>>): ComponentType<{ api: Api }> {
  const L = lazy(async () => ({ default: await load() }));
  return function DataApp(props: { api: Api }) {
    return (
      <Suspense fallback={<div className="wb-loading">Loading…</div>}>
        <L {...props} />
      </Suspense>
    );
  };
}

/** Error text without the "code:" prefix the main process adds. */
export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').replace(/^[a-z-]+: /, '');
}

/** Loads data from the main process; reload() re-runs it. */
export function useLoad<T>(api: Api, method: string, payload: unknown, deps: unknown[]): { data: T | null; error: string; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    if (payload === undefined) { setData(null); return; }
    setLoading(true);
    setError('');
    api.invoke<T>(method, payload).then((d) => live && setData(d), (e) => live && setError(errText(e))).finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: useCallback(() => setN((x) => x + 1), []) };
}

export function fmt(x: unknown, d = 4): string {
  if (x === null || x === undefined) return '—';
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) return '—';
    if (Number.isInteger(x) && Math.abs(x) < 1e15) return x.toLocaleString('en');
    const a = Math.abs(x);
    return a !== 0 && (a < 1e-3 || a >= 1e7) ? x.toExponential(2) : (+x.toFixed(d)).toString();
  }
  return String(x);
}

export function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—';
}

export function ErrorBox({ text }: { text: string }) {
  return text ? <div className="dsm-error" role="alert">{text}</div> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="dsm-empty">{children}</div>;
}

export function Tabs<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="wb-seg dsm-tabs" role="tablist">
      {options.map(([v, label]) => (
        <button key={v} role="tab" aria-selected={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- dataset picker

export interface DatasetRow { id: string; name: string; versions: number; latestVersionId: string | null; createdAt: string; licence: string; source: string; citation: string; notes: string }
export interface VersionRow { id: string; datasetId: string; parentId: string | null; label: string; createdAt: string; sha256: string; rows: number; cols: number; steps: Array<{ op: string }>; reports: Array<{ op: string; rowsIn: number; rowsOut: number; note?: string }>; notes: string[]; format: string; sourcePath: string | null; truncated: boolean }
export interface ColumnSchema { name: string; type: string; nullable: boolean; confidence: number }

export function VersionPicker({ api, value, onChange }: { api: Api; value: string; onChange: (versionId: string) => void }) {
  const ds = useLoad<DatasetRow[]>(api, 'datasets.list', {}, []);
  const [datasetId, setDatasetId] = useState('');
  const versions = useLoad<VersionRow[]>(api, 'datasets.versions', datasetId ? { datasetId } : undefined, [datasetId]);
  useEffect(() => {
    if (!datasetId && ds.data?.length) setDatasetId(ds.data[0].id);
  }, [ds.data, datasetId]);
  useEffect(() => {
    const vs = versions.data;
    if (vs?.length && !vs.some((v) => v.id === value)) onChange(vs[vs.length - 1].id);
  }, [versions.data, value, onChange]);
  if (ds.data && !ds.data.length) return <span className="dsm-muted">No datasets yet. Import one in the Datasets app.</span>;
  return (
    <span className="dsm-row">
      <select className="wb-select" aria-label="Dataset" value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
        {ds.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <select className="wb-select" aria-label="Version" value={value} onChange={(e) => onChange(e.target.value)}>
        {versions.data?.map((v) => <option key={v.id} value={v.id}>{v.label} ({fmt(v.rows)} rows)</option>)}
      </select>
    </span>
  );
}

// ----------------------------------------------------------------- data grid

export function DataGrid({ columns, rows, start = 0, highlight }: { columns: string[]; rows: unknown[][]; start?: number; highlight?: Set<string> }) {
  return (
    <div className="dsm-grid-wrap">
      <table className="wb-table dsm-grid">
        <thead>
          <tr>
            <th className="dsm-rownum">#</th>
            {columns.map((c) => <th key={c} className={highlight?.has(c) ? 'dsm-hl' : ''} title={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="dsm-rownum">{start + i + 1}</td>
              {r.map((v, j) => <td key={j} className={v === null ? 'dsm-null' : typeof v === 'number' ? 'dsm-num' : ''}>{v === null ? '∅' : String(v).slice(0, 200)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ----------------------------------------------------------------- SVG charts

const W = 560;
const H = 260;
const M = { l: 52, r: 12, t: 10, b: 36 };
const PALETTE = ['var(--accent)', '#e8833a', '#4caf7d', '#c75fb6', '#d9b62b', '#5a8de8', '#e05a5a', '#55b8c9'];

function scale(lo: number, hi: number, a: number, b: number) {
  const d = hi - lo || 1;
  return (v: number) => a + ((v - lo) / d) * (b - a);
}

function ticks(lo: number, hi: number, n = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) return [lo];
  const step = 10 ** Math.floor(Math.log10((hi - lo) / n));
  const err = (hi - lo) / n / step;
  const s = step * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
  const out: number[] = [];
  for (let v = Math.ceil(lo / s) * s; v <= hi + 1e-9 * s; v += s) out.push(+v.toPrecision(12));
  return out;
}

function Axes({ x, y, xs, ys, xLabel, yLabel, xFmt = fmt }: { x: (v: number) => number; y: (v: number) => number; xs: number[]; ys: number[]; xLabel?: string; yLabel?: string; xFmt?: (v: number) => string }) {
  return (
    <g className="dsm-axes">
      <line x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} />
      <line x1={M.l} x2={M.l} y1={M.t} y2={H - M.b} />
      {ys.map((v) => (
        <g key={`y${v}`}>
          <line className="dsm-gridline" x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} />
          <text x={M.l - 6} y={y(v) + 4} textAnchor="end">{fmt(v, 3)}</text>
        </g>
      ))}
      {xs.map((v) => <text key={`x${v}`} x={x(v)} y={H - M.b + 16} textAnchor="middle">{xFmt(v)}</text>)}
      {xLabel && <text x={(M.l + W - M.r) / 2} y={H - 4} textAnchor="middle" className="dsm-axis-label">{xLabel}</text>}
      {yLabel && <text x={12} y={(M.t + H - M.b) / 2} textAnchor="middle" transform={`rotate(-90 12 ${(M.t + H - M.b) / 2})`} className="dsm-axis-label">{yLabel}</text>}
    </g>
  );
}

export function Chart({ data, title }: { data: ChartData; title?: string }) {
  const label = title ?? `${data.kind} of ${data.x}`;
  let body: ReactNode = null;
  let legend: string[] = [];
  if (data.kind === 'histogram') {
    const lo = data.edges[0];
    const hi = data.edges[data.edges.length - 1];
    const max = Math.max(...data.counts, 1);
    const x = scale(lo, hi, M.l, W - M.r);
    const y = scale(0, max, H - M.b, M.t);
    body = (
      <>
        <Axes x={x} y={y} xs={ticks(lo, hi)} ys={ticks(0, max)} xLabel={data.x} yLabel="count" />
        {data.counts.map((c, i) => <rect key={i} className="dsm-bar" x={x(data.edges[i]) + 0.5} width={Math.max(1, x(data.edges[i + 1]) - x(data.edges[i]) - 1)} y={y(c)} height={H - M.b - y(c)}><title>{`${fmt(data.edges[i])} – ${fmt(data.edges[i + 1])}: ${c}`}</title></rect>)}
      </>
    );
  } else if (data.kind === 'bar') {
    const max = Math.max(...data.values, 0);
    const min = Math.min(...data.values, 0);
    const y = scale(min, max || 1, H - M.b, M.t);
    const bw = (W - M.l - M.r) / Math.max(1, data.categories.length);
    body = (
      <>
        <Axes x={() => 0} y={y} xs={[]} ys={ticks(min, max || 1)} yLabel={data.y} />
        {data.values.map((v, i) => (
          <g key={i}>
            <rect className="dsm-bar" x={M.l + i * bw + 2} width={Math.max(1, bw - 4)} y={Math.min(y(v), y(0))} height={Math.abs(y(0) - y(v))}><title>{`${data.categories[i]}: ${fmt(v)}`}</title></rect>
            {bw > 26 && <text x={M.l + i * bw + bw / 2} y={H - M.b + 14} textAnchor="middle" className="dsm-tick-small">{data.categories[i].slice(0, Math.floor(bw / 6))}</text>}
          </g>
        ))}
      </>
    );
  } else if (data.kind === 'line' || data.kind === 'scatter') {
    const pts = data.points;
    const xsv = pts.map((p) => p[0]);
    const ysv = pts.map((p) => p[1]);
    const xlo = Math.min(...xsv), xhi = Math.max(...xsv), ylo = Math.min(...ysv), yhi = Math.max(...ysv);
    const x = scale(xlo, xhi, M.l, W - M.r);
    const y = scale(ylo, yhi, H - M.b, M.t);
    const xFmt = data.kind === 'line' && data.xIsDate ? (v: number) => new Date(v).toISOString().slice(0, 10) : fmt;
    if (data.kind === 'line') {
      body = (
        <>
          <Axes x={x} y={y} xs={ticks(xlo, xhi, 4)} ys={ticks(ylo, yhi)} xLabel={data.x} yLabel={data.y} xFmt={xFmt} />
          <polyline className="dsm-line" points={pts.map((p) => `${x(p[0])},${y(p[1])}`).join(' ')} />
        </>
      );
    } else {
      const groups = [...new Set(pts.map((p) => p[2] ?? ''))].slice(0, PALETTE.length);
      legend = groups.filter(Boolean) as string[];
      body = (
        <>
          <Axes x={x} y={y} xs={ticks(xlo, xhi)} ys={ticks(ylo, yhi)} xLabel={data.x} yLabel={data.y} />
          {pts.map((p, i) => <circle key={i} cx={x(p[0])} cy={y(p[1])} r={2.4} fill={PALETTE[Math.max(0, groups.indexOf(p[2] ?? '')) % PALETTE.length]} opacity={0.7} />)}
        </>
      );
    }
  } else if (data.kind === 'box') {
    const lo = Math.min(...data.groups.map((g) => g.min));
    const hi = Math.max(...data.groups.map((g) => g.max));
    const y = scale(lo, hi, H - M.b, M.t);
    const bw = (W - M.l - M.r) / Math.max(1, data.groups.length);
    body = (
      <>
        <Axes x={() => 0} y={y} xs={[]} ys={ticks(lo, hi)} yLabel={data.x} />
        {data.groups.map((g, i) => {
          const cx = M.l + i * bw + bw / 2;
          const w = Math.min(40, bw * 0.6);
          return (
            <g key={g.name} className="dsm-box">
              <line x1={cx} x2={cx} y1={y(g.min)} y2={y(g.max)} />
              <rect x={cx - w / 2} width={w} y={y(g.q3)} height={Math.max(1, y(g.q1) - y(g.q3))} />
              <line className="dsm-median" x1={cx - w / 2} x2={cx + w / 2} y1={y(g.median)} y2={y(g.median)} />
              <text x={cx} y={H - M.b + 14} textAnchor="middle" className="dsm-tick-small">{g.name.slice(0, 12)}</text>
              <title>{`${g.name}: n=${g.n}, median ${fmt(g.median)}, IQR ${fmt(g.q1)}–${fmt(g.q3)}`}</title>
            </g>
          );
        })}
      </>
    );
  }
  return (
    <figure className="dsm-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>{body}</svg>
      {legend.length > 0 && <figcaption className="dsm-legend">{legend.map((g, i) => <span key={g}><i style={{ background: PALETTE[i % PALETTE.length] }} />{g}</span>)}</figcaption>}
      {'truncated' in data && data.truncated && <figcaption className="dsm-muted">Showing the 40 largest categories.</figcaption>}
      {'sampled' in data && data.sampled && <figcaption className="dsm-muted">Showing a random sample of 5,000 of {fmt(data.total)} points.</figcaption>}
    </figure>
  );
}

export function MiniHistogram({ counts }: { counts: number[] }) {
  const max = Math.max(...counts, 1);
  const w = 120;
  const h = 28;
  const bw = w / Math.max(1, counts.length);
  return (
    <svg width={w} height={h} className="dsm-spark" aria-hidden>
      {counts.map((c, i) => <rect key={i} x={i * bw} width={Math.max(1, bw - 1)} y={h - (c / max) * h} height={(c / max) * h} />)}
    </svg>
  );
}

/** Correlation or confusion matrix as a coloured grid. */
export function Heatmap({ rows, cols, values, diverging, format = (v: number) => fmt(v, 2), title }: { rows: string[]; cols: string[]; values: number[][]; diverging?: boolean; format?: (v: number) => string; title: string }) {
  const max = Math.max(...values.flat().filter(Number.isFinite).map(Math.abs), 1e-9);
  return (
    <div className="dsm-heat-wrap">
      <table className="dsm-heat" aria-label={title}>
        <thead><tr><th />{cols.map((c) => <th key={c} title={c}>{c.slice(0, 14)}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r}>
              <th title={r}>{r.slice(0, 18)}</th>
              {values[i].map((v, j) => {
                const a = Number.isFinite(v) ? Math.abs(v) / max : 0;
                const bg = !Number.isFinite(v) ? 'transparent' : diverging && v < 0 ? `color-mix(in srgb, var(--danger) ${Math.round(a * 70)}%, transparent)` : `color-mix(in srgb, var(--accent) ${Math.round(a * 70)}%, transparent)`;
                return <td key={j} style={{ background: bg }}>{format(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RocChart({ fpr, tpr, auc }: { fpr: number[]; tpr: number[]; auc?: number }) {
  const s = 200;
  const p = 24;
  const x = (v: number) => p + v * (s - 2 * p);
  const y = (v: number) => s - p - v * (s - 2 * p);
  return (
    <figure className="dsm-chart dsm-roc">
      <svg viewBox={`0 0 ${s} ${s}`} role="img" aria-label="ROC curve">
        <g className="dsm-axes"><line x1={p} x2={s - p} y1={s - p} y2={s - p} /><line x1={p} x2={p} y1={p} y2={s - p} /></g>
        <line className="dsm-diag" x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} />
        <polyline className="dsm-line" points={fpr.map((f, i) => `${x(f)},${y(tpr[i])}`).join(' ')} />
        <text x={s / 2} y={s - 4} textAnchor="middle" className="dsm-axis-label">false positive rate</text>
      </svg>
      {auc !== undefined && <figcaption>ROC AUC {fmt(auc, 3)}</figcaption>}
    </figure>
  );
}

export function LearningCurve({ train, val, metric, best }: { train: number[]; val?: number[]; metric: string; best?: number }) {
  const w = 320, h = 180, p = 28;
  const all = [...train, ...(val ?? [])].filter(Number.isFinite);
  if (train.length < 2 || !all.length) return null;
  const lo = Math.min(...all), hi = Math.max(...all);
  const n = Math.max(train.length, val?.length ?? 0);
  const x = (i: number) => p + (i / Math.max(1, n - 1)) * (w - 2 * p);
  const y = (v: number) => h - p - ((v - lo) / (hi - lo || 1)) * (h - 2 * p);
  const line = (vs: number[]) => vs.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  return (
    <figure className="dsm-chart dsm-curve">
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Training curve (${metric})`}>
        <g className="dsm-axes"><line x1={p} x2={w - p} y1={h - p} y2={h - p} /><line x1={p} x2={p} y1={p} y2={h - p} /></g>
        <polyline className="dsm-line" points={line(train)} />
        {val && val.length > 1 && <polyline className="dsm-line dsm-line-val" points={line(val)} />}
        <text x={w / 2} y={h - 6} textAnchor="middle" className="dsm-axis-label">epoch / round</text>
        <text x={p} y={p - 8} className="dsm-axis-label">{fmt(hi, 3)}</text>
        <text x={p} y={h - p + 12} className="dsm-axis-label">{fmt(lo, 3)}</text>
      </svg>
      <figcaption>{metric}: <span className="dsm-key-train">training</span>{val && <> · <span className="dsm-key-val">validation</span></>}{best ? ` · best at ${best}` : ''}</figcaption>
    </figure>
  );
}

export function Bars({ items, signed }: { items: Array<{ label: string; value: number }>; signed?: boolean }) {
  const max = Math.max(...items.map((i) => Math.abs(i.value)), 1e-12);
  return (
    <div className="dsm-hbars">
      {items.map((i) => (
        <div key={i.label} className="dsm-hbar">
          <span className="dsm-hbar-label" title={i.label}>{i.label}</span>
          <span className="dsm-hbar-track"><span className={`dsm-hbar-fill${signed && i.value < 0 ? ' neg' : ''}`} style={{ width: `${(Math.abs(i.value) / max) * 100}%` }} /></span>
          <span className="dsm-num">{fmt(i.value, 4)}</span>
        </div>
      ))}
    </div>
  );
}

/** Column names that are usually identifiers, skipped when picking defaults. */
export function looksLikeIdName(name: string): boolean {
  return /(^|[_\s-])(id|uuid|guid|key|index)$|^id[_\s-]|^(row|serial)(_?(no|num|number))?$/i.test(name);
}
