/**
 * Main-process half of the Data Science & ML module: validated IPC handlers
 * over the store, the data workspace and the native trainer.
 */
import type { AetherMainModule, MainHost } from '@aether/plugin-api';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { type Cell, DataError, LIMITS, rowObject, sliceRows } from './table.js';
import { type DataFormat, SUPPORTED_EXTENSIONS, loadDataset } from './io.js';
import { inferSchema } from './schema.js';
import { profileTable } from './profile.js';
import { runPipeline, pipelineToPandas, validateSteps } from './pipeline.js';
import { type ChartRequest, chartData } from './charts.js';
import { correlationMatrix } from './stats.js';
import { compareTables } from './compare.js';
import { toCsv } from './csv.js';
import { toJsonLines, toJsonRecords } from './jsonio.js';
import { FileGuard } from './files.js';
import { DataStore } from './store.js';
import { type ExperimentConfig, type ExperimentResult, predictWith, runExperiment } from './ml/experiment.js';
import { DEFAULT_PARAMS, MODEL_INFO, type ModelType } from './ml/models.js';
import { validateArtifact } from './ml/artifact.js';
import { runToSklearn } from './ml/sklearn.js';
import { runReport } from './report.js';
import { redactText } from './pii.js';

export const MODULE_ID = 'aether.module.data';

type Ctx = { windowId: number; profileId: string; isPrivate: boolean };
type P = Record<string, unknown>;

// ---------------------------------------------------------------- payload validation

function obj(p: unknown): P {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new DataError('bad-request', 'Payload must be an object.');
  return p as P;
}
function str(p: P, k: string, max = 500, optional = false): string {
  const v = p[k];
  if (v === undefined && optional) return '';
  if (typeof v !== 'string' || v.length > max) throw new DataError('bad-request', `${k} must be text (max ${max}).`);
  return v;
}
function id(p: P, k: string): string {
  const v = str(p, k, 40);
  if (!/^[0-9a-f-]{36}$/.test(v)) throw new DataError('bad-request', `${k} is not a valid id.`);
  return v;
}
function int(p: P, k: string, lo: number, hi: number, dflt?: number): number {
  const v = p[k] === undefined ? dflt : p[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new DataError('bad-request', `${k} must be a number.`);
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}
function strList(p: P, k: string, max: number = LIMITS.maxColumns): string[] {
  const v = p[k];
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === 'string' && x.length <= 600)) throw new DataError('bad-request', `${k} must be a list of names.`);
  return v as string[];
}

export function validateExperimentConfig(raw: unknown): ExperimentConfig {
  const p = obj(raw);
  const split = obj(p.split ?? {});
  const strategy = ['random', 'stratified', 'group', 'time'].includes(split.strategy as string) ? (split.strategy as ExperimentConfig['split']['strategy']) : 'random';
  const tf = typeof split.testFraction === 'number' ? split.testFraction : 0.2;
  const model = p.model as ModelType;
  if (!Object.prototype.hasOwnProperty.call(MODEL_INFO, model)) throw new DataError('bad-request', 'Unknown model.');
  const params = p.params === undefined ? {} : obj(p.params);
  let search: ExperimentConfig['search'];
  if (p.search !== undefined && p.search !== null) {
    const s = obj(p.search);
    const space: Record<string, Array<number | string>> = {};
    for (const [k, v] of Object.entries(obj(s.space ?? {}))) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_PARAMS[model], k)) continue;
      if (Array.isArray(v) && v.length <= 20 && v.every((x) => (typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && x.length < 20))) space[k] = v as Array<number | string>;
    }
    search = { method: s.method === 'random' ? 'random' : 'grid', space, maxTrials: int(s, 'maxTrials', 1, 50, 20) };
  }
  return {
    target: str(p, 'target', 600),
    features: strList(p, 'features', 500),
    task: p.task === 'classification' || p.task === 'regression' ? p.task : 'auto',
    model,
    params,
    split: {
      strategy,
      testFraction: Math.min(0.5, Math.max(0.05, tf)),
      seed: int(split, 'seed', 0, 2 ** 31 - 1, 42),
      stratifyBy: typeof split.stratifyBy === 'string' ? split.stratifyBy.slice(0, 600) : undefined,
      groupBy: typeof split.groupBy === 'string' && split.groupBy ? split.groupBy.slice(0, 600) : undefined,
      timeColumn: typeof split.timeColumn === 'string' && split.timeColumn ? split.timeColumn.slice(0, 600) : undefined,
    },
    cvFolds: p.cvFolds === undefined ? 0 : int(p, 'cvFolds', 0, 10),
    search,
    scale: p.scale !== false,
    classWeight: p.classWeight === 'balanced' ? 'balanced' : 'none',
    timeLimitSec: p.timeLimitSec === undefined ? 120 : int(p, 'timeLimitSec', 5, 1800),
  };
}

/** The stored result without the (possibly large) model artifact. */
function summary(r: ExperimentResult): Omit<ExperimentResult, 'artifact'> & { artifactBytes: number } {
  const { artifact, ...rest } = r;
  return { ...rest, artifactBytes: JSON.stringify(artifact).length };
}

export function createMainModule(): AetherMainModule {
  let host: MainHost | null = null;
  let store: DataStore | null = null;
  let guard: FileGuard | null = null;
  const jobs = new Map<string, { ac: AbortController; profileId: string; windowId: number }>();

  const S = () => store ?? (() => { throw new DataError('not-ready', 'Module not active.'); })();
  const G = () => guard ?? (() => { throw new DataError('not-ready', 'Module not active.'); })();

  async function importBytes(ctx: Ctx, bytes: Uint8Array, name: string, opts: { maxRows?: number; format?: DataFormat; sourcePath?: string; datasetName?: string; source?: string }) {
    const loaded = await loadDataset(bytes, name, opts);
    const dsId = S().createDataset(ctx.profileId, opts.datasetName || name.replace(/\.[^.]+$/, ''), { source: opts.source ?? opts.sourcePath ?? '' });
    const v = S().addVersion(dsId, loaded.table, { label: 'Imported', format: loaded.format, sourcePath: opts.sourcePath ?? null, sourceSha256: loaded.sha256, notes: loaded.notes, truncated: loaded.truncated });
    return { datasetId: dsId, version: v, notes: loaded.notes };
  }

  const handlers: Record<string, (p: unknown, ctx: Ctx) => unknown> = {
    // ------------------------------------------------ datasets
    'datasets.list': (_p, ctx) => S().listDatasets(ctx.profileId),
    'datasets.versions': (p, ctx) => { const d = id(obj(p), 'datasetId'); S().getDataset(ctx.profileId, d); return S().listVersions(d); },
    'datasets.import': async (p, ctx) => {
      const q = obj(p ?? {});
      const dialogs = host?.dialogs;
      if (!dialogs) throw new DataError('no-permission', 'Opening files needs the “Open and save files you choose” permission.');
      const picked = await dialogs.openFile({ title: 'Open a dataset', filters: [{ name: 'Data files', extensions: SUPPORTED_EXTENSIONS }] });
      if (!picked.length) return null;
      const path = G().grantFile(picked[0]);
      const { bytes } = await G().read(path);
      return importBytes(ctx, bytes, basename(path), { sourcePath: path, maxRows: q.maxRows === undefined ? undefined : int(q, 'maxRows', 1, 10_000_000) });
    },
    'datasets.importText': async (p, ctx) => {
      const q = obj(p);
      const text = str(q, 'text', 20 * 1024 * 1024);
      const name = str(q, 'name', 200, true) || 'Pasted data';
      const format = (['csv', 'tsv', 'json', 'jsonl'] as const).find((f) => f === q.format);
      return importBytes(ctx, new TextEncoder().encode(text), `${name}.${format ?? 'csv'}`, { format, datasetName: name, source: 'Pasted text' });
    },
    'datasets.update': (p, ctx) => { const q = obj(p); S().updateDataset(ctx.profileId, id(q, 'datasetId'), { name: q.name as string, licence: q.licence as string, source: q.source as string, citation: q.citation as string, notes: q.notes as string }); return true; },
    'datasets.delete': (p, ctx) => { S().deleteDataset(ctx.profileId, id(obj(p), 'datasetId')); return true; },
    'version.get': (p, ctx) => {
      const vId = id(obj(p), 'versionId');
      const v = S().getOwnedVersion(ctx.profileId, vId);
      return { version: v, dataset: S().getDataset(ctx.profileId, v.datasetId), schema: inferSchema(S().loadTable(vId)) };
    },
    'version.rows': (p, ctx) => {
      const q = obj(p);
      const vId = id(q, 'versionId');
      S().getOwnedVersion(ctx.profileId, vId);
      const t = S().loadTable(vId);
      return { columns: t.columns.map((c) => c.name), rows: sliceRows(t, int(q, 'start', 0, Number.MAX_SAFE_INTEGER, 0), int(q, 'count', 1, LIMITS.maxPageRows, 100)) };
    },
    'version.profile': (p, ctx) => { const vId = id(obj(p), 'versionId'); S().getOwnedVersion(ctx.profileId, vId); return profileTable(S().loadTable(vId)); },
    'version.chart': (p, ctx) => {
      const q = obj(p);
      const vId = id(q, 'versionId');
      S().getOwnedVersion(ctx.profileId, vId);
      const r = obj(q.request);
      const kind = ['histogram', 'bar', 'line', 'scatter', 'box'].includes(r.kind as string) ? (r.kind as ChartRequest['kind']) : 'histogram';
      return chartData(S().loadTable(vId), { kind, x: str(r, 'x', 600), y: str(r, 'y', 600, true) || undefined, group: str(r, 'group', 600, true) || undefined, agg: r.agg === 'mean' || r.agg === 'count' ? r.agg : 'sum', bins: r.bins === undefined ? undefined : int(r, 'bins', 2, 100) });
    },
    'version.correlation': (p, ctx) => { const q = obj(p); const vId = id(q, 'versionId'); S().getOwnedVersion(ctx.profileId, vId); return correlationMatrix(S().loadTable(vId), strList(q, 'columns', 60), q.method === 'spearman' ? 'spearman' : 'pearson'); },
    'version.compare': (p, ctx) => {
      const q = obj(p);
      const a = id(q, 'a');
      const b = id(q, 'b');
      S().getOwnedVersion(ctx.profileId, a);
      S().getOwnedVersion(ctx.profileId, b);
      return compareTables(S().loadTable(a), S().loadTable(b), { key: q.key === undefined ? undefined : strList(q, 'key', 10) });
    },
    'version.export': async (p, ctx) => {
      const q = obj(p);
      const vId = id(q, 'versionId');
      const v = S().getOwnedVersion(ctx.profileId, vId);
      const format = q.format === 'json' || q.format === 'jsonl' ? q.format : 'csv';
      if (!host?.dialogs) throw new DataError('no-permission', 'Saving files needs the “Open and save files you choose” permission.');
      const ds = S().getDataset(ctx.profileId, v.datasetId);
      const target = await host.dialogs.saveFile({ title: 'Export dataset', defaultPath: `${ds.name.replace(/[^\w.-]+/g, '_')}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
      if (!target) return null;
      const t = S().loadTable(vId);
      const text = format === 'csv' ? toCsv(t, { protectFormulas: q.protectFormulas !== false }) : format === 'json' ? toJsonRecords(t) : toJsonLines(t);
      return G().write(G().grantFile(target), text);
    },
    // ------------------------------------------------ pipelines
    'pipeline.preview': (p, ctx) => {
      const q = obj(p);
      const vId = id(q, 'versionId');
      S().getOwnedVersion(ctx.profileId, vId);
      const { table, reports } = runPipeline(S().loadTable(vId), validateSteps(q.steps));
      return { columns: table.columns.map((c) => c.name), rows: sliceRows(table, 0, 200), reports, schema: inferSchema(table) };
    },
    'pipeline.apply': (p, ctx) => {
      const q = obj(p);
      const vId = id(q, 'versionId');
      const v = S().getOwnedVersion(ctx.profileId, vId);
      const steps = validateSteps(q.steps);
      if (!steps.length) throw new DataError('bad-request', 'Add at least one step.');
      const { table, reports } = runPipeline(S().loadTable(vId), steps);
      return S().addVersion(v.datasetId, table, { parentId: vId, label: str(q, 'label', 200, true) || `Cleaned (${steps.length} step${steps.length > 1 ? 's' : ''})`, format: v.format, sourcePath: v.sourcePath, sourceSha256: v.sourceSha256, steps: [...v.steps, ...steps], reports, notes: [] });
    },
    'pipeline.pandas': (p, ctx) => {
      const q = obj(p);
      const vId = id(q, 'versionId');
      const v = S().getOwnedVersion(ctx.profileId, vId);
      return pipelineToPandas([...v.steps, ...validateSteps(q.steps ?? [])], { path: v.sourcePath ? basename(v.sourcePath) : undefined, format: v.format });
    },
    // ------------------------------------------------ machine learning
    'ml.models': () => Object.entries(MODEL_INFO).map(([type, info]) => ({ type, ...info, defaults: DEFAULT_PARAMS[type as ModelType] })),
    'ml.train': async (p, ctx) => {
      const q = obj(p);
      const vId = id(q, 'versionId');
      S().getOwnedVersion(ctx.profileId, vId);
      const cfg = validateExperimentConfig(q.config);
      const jobId = randomUUID();
      const ac = new AbortController();
      jobs.set(jobId, { ac, profileId: ctx.profileId, windowId: ctx.windowId });
      host?.ipc.emit('ml.started', { jobId }, ctx.windowId);
      try {
        const r = await runExperiment(S().loadTable(vId), cfg, { signal: ac.signal, onProgress: (progress, stage) => host?.ipc.emit('ml.progress', { jobId, progress, stage }, ctx.windowId) });
        const name = str(q, 'name', 200, true) || `${MODEL_INFO[cfg.model].title} → ${cfg.target}`;
        const runId = S().addRun(ctx.profileId, vId, { name, task: r.task, model: cfg.model, metricName: r.primary.name, metricValue: r.primary.value, baselineValue: r.primary.baseline, durationMs: r.durationMs, config: r.config, result: { ...summary(r), artifact: r.artifact } });
        return { runId, result: summary(r) };
      } finally {
        jobs.delete(jobId);
      }
    },
    'ml.cancel': (_p, ctx) => { let n = 0; for (const j of jobs.values()) if (j.profileId === ctx.profileId && j.windowId === ctx.windowId) { j.ac.abort(); n++; } return n; },
    'runs.list': (p, ctx) => { const q = obj(p ?? {}); return S().listRuns(ctx.profileId, q.versionIds === undefined ? undefined : strList(q, 'versionIds', 1000)); },
    'runs.get': (p, ctx) => { const r = S().getRun(ctx.profileId, id(obj(p), 'runId')); const { artifact, ...result } = r.result; return { ...r, result }; },
    'runs.update': (p, ctx) => { const q = obj(p); S().updateRun(ctx.profileId, id(q, 'runId'), { name: q.name as string, notes: q.notes as string }); return true; },
    'runs.delete': (p, ctx) => { S().deleteRun(ctx.profileId, id(obj(p), 'runId')); return true; },
    'runs.report': (p, ctx) => {
      const r = S().getRun(ctx.profileId, id(obj(p), 'runId'));
      const v = S().getOwnedVersion(ctx.profileId, r.versionId);
      return runReport(r, r.result as unknown as ExperimentResult, v, S().getDataset(ctx.profileId, v.datasetId));
    },
    'runs.sklearn': (p, ctx) => {
      const r = S().getRun(ctx.profileId, id(obj(p), 'runId'));
      const v = S().getOwnedVersion(ctx.profileId, r.versionId);
      const res = r.result as unknown as ExperimentResult;
      return runToSklearn(res.config, validateArtifact(r.result.artifact), { path: v.sourcePath ? basename(v.sourcePath) : undefined, format: v.format, steps: v.steps });
    },
    'model.predict': (p, ctx) => {
      const q = obj(p);
      const r = S().getRun(ctx.profileId, id(q, 'runId'));
      const art = validateArtifact(r.result.artifact);
      const rows = q.rows;
      if (!Array.isArray(rows) || rows.length > 1000) throw new DataError('bad-request', 'rows must be a list of up to 1000 objects.');
      const clean = rows.map((x) => { const o: Record<string, Cell> = Object.create(null); for (const k of art.inputs) { const v = (obj(x) as P)[k]; o[k] = v === undefined || v === null ? null : typeof v === 'string' ? v.slice(0, LIMITS.maxCellChars) : typeof v === 'number' || typeof v === 'boolean' ? v : null; } return o; });
      return { inputs: art.inputs, target: art.target, predictions: predictWith(art, clean) };
    },
    'model.predictVersion': (p, ctx) => {
      const q = obj(p);
      const r = S().getRun(ctx.profileId, id(q, 'runId'));
      const art = validateArtifact(r.result.artifact);
      const vId = id(q, 'versionId');
      const v = S().getOwnedVersion(ctx.profileId, vId);
      const t = S().loadTable(vId);
      const missing = art.inputs.filter((c) => !t.columns.some((x) => x.name === c));
      if (missing.length) throw new DataError('ml', `This dataset lacks the model's input columns: ${missing.join(', ')}.`);
      const n = t.columns[0]?.values.length ?? 0;
      const preds = predictWith(art, Array.from({ length: n }, (_, i) => rowObject(t, i)));
      const name = `prediction(${art.target.name})`;
      const out = { columns: [...t.columns.filter((c) => c.name !== name), { name, values: preds.map((x) => x.prediction) }] };
      return S().addVersion(v.datasetId, out, { parentId: vId, label: `Predictions from “${r.name}”`, format: v.format, sourcePath: v.sourcePath, sourceSha256: v.sourceSha256, steps: v.steps, notes: [`Predictions from run ${r.id} (${r.model}).`] });
    },
    'model.export': async (p, ctx) => {
      const r = S().getRun(ctx.profileId, id(obj(p), 'runId'));
      if (!host?.dialogs) throw new DataError('no-permission', 'Saving files needs the “Open and save files you choose” permission.');
      const target = await host.dialogs.saveFile({ title: 'Export model', defaultPath: `${r.name.replace(/[^\w.-]+/g, '_').slice(0, 80)}.aether-model.json`, filters: [{ name: 'AETHER model', extensions: ['json'] }] });
      if (!target) return null;
      return G().write(G().grantFile(target), JSON.stringify(validateArtifact(r.result.artifact)));
    },
    'model.import': async (p, ctx) => {
      const q = obj(p);
      const vId = id(q, 'versionId');
      S().getOwnedVersion(ctx.profileId, vId);
      if (!host?.dialogs) throw new DataError('no-permission', 'Opening files needs the “Open and save files you choose” permission.');
      const picked = await host.dialogs.openFile({ title: 'Import an AETHER model', filters: [{ name: 'AETHER model', extensions: ['json'] }] });
      if (!picked.length) return null;
      const { bytes } = await G().read(G().grantFile(picked[0]), 200 * 1024 * 1024);
      let raw: unknown;
      try { raw = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new DataError('bad-model', 'The file is not JSON.'); }
      const art = validateArtifact(raw, bytes.byteLength);
      return S().addRun(ctx.profileId, vId, { name: `Imported: ${basename(picked[0])}`.slice(0, 200), task: art.target.task, model: art.model.type, metricName: '—', metricValue: null, baselineValue: null, durationMs: 0, config: { target: art.target.name, features: art.inputs, model: art.model.type }, result: { imported: true, artifact: art }, imported: true });
    },
    // ------------------------------------------------ privacy helpers
    'pii.redact': (p) => redactText(str(obj(p), 'text', 2_000_000)),
  };

  return {
    id: MODULE_ID,
    activate(h: MainHost) {
      host = h;
      store = new DataStore(h.storage, h.dataDir);
      guard = new FileGuard(h.dataDir);
      for (const [method, fn] of Object.entries(handlers)) {
        h.ipc.handle(method, async (payload, ctx) => {
          try {
            return await fn(payload, ctx);
          } catch (e) {
            if (e instanceof DataError) throw new Error(`${e.code}: ${e.message}`);
            h.log.error(`[data] ${method} failed`, e);
            throw new Error(`internal: ${method} failed. ${e instanceof Error ? e.message.slice(0, 300) : ''}`);
          }
        });
      }
      h.events.on('profileDeleted', ({ profileId }) => store?.deleteProfile(profileId));
      h.events.on('appWillQuit', () => { for (const j of jobs.values()) j.ac.abort(); });
    },
    deactivate() {
      for (const j of jobs.values()) j.ac.abort();
      jobs.clear();
      host = null;
      store = null;
      guard = null;
    },
  };
}
