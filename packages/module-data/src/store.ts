/**
 * Persistence in the module's own SQLite file (host.storage.db) plus table
 * snapshots in dataDir. Every dataset version is immutable: a cleaning
 * pipeline creates a new version that records its parent, its steps and the
 * SHA-256 of its content, so any experiment can name exactly what it trained on.
 */
import { gunzipSync, gzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModuleStorage } from '@aether/plugin-api';
import { type Table, DataError, rowCount } from './table.js';
import { sha256 } from './io.js';
import type { Step, StepReport } from './pipeline.js';

export const TABLE_PREFIX = 'data_';

const MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE IF NOT EXISTS data_datasets (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL,
  licence TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', citation TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS data_versions (
  id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, parent_id TEXT, label TEXT NOT NULL, created_at TEXT NOT NULL,
  sha256 TEXT NOT NULL, source_sha256 TEXT, format TEXT NOT NULL, source_path TEXT, rows INTEGER NOT NULL, cols INTEGER NOT NULL,
  steps TEXT NOT NULL DEFAULT '[]', reports TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '[]', truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS data_versions_ds ON data_versions(dataset_id);
CREATE TABLE IF NOT EXISTS data_runs (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, version_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL,
  task TEXT NOT NULL, model TEXT NOT NULL, metric_name TEXT NOT NULL, metric_value REAL, baseline_value REAL,
  duration_ms INTEGER NOT NULL, config TEXT NOT NULL, result TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', imported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS data_runs_version ON data_runs(version_id);
`,
  },
];

export interface DatasetRow {
  id: string;
  name: string;
  createdAt: string;
  licence: string;
  source: string;
  citation: string;
  notes: string;
  versions: number;
  latestVersionId: string | null;
}

export interface VersionRow {
  id: string;
  datasetId: string;
  parentId: string | null;
  label: string;
  createdAt: string;
  sha256: string;
  sourceSha256: string | null;
  format: string;
  sourcePath: string | null;
  rows: number;
  cols: number;
  steps: Step[];
  reports: StepReport[];
  notes: string[];
  truncated: boolean;
}

export interface RunRow {
  id: string;
  versionId: string;
  name: string;
  createdAt: string;
  task: string;
  model: string;
  metricName: string;
  metricValue: number | null;
  baselineValue: number | null;
  durationMs: number;
  notes: string;
  imported: boolean;
}

/** Content hash of a table (column names + values), independent of file format. */
export function tableHash(t: Table): string {
  return sha256(JSON.stringify(t.columns.map((c) => [c.name, c.values])));
}

const json = <T>(s: unknown, fallback: T): T => {
  try {
    return typeof s === 'string' ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

export class DataStore {
  private cache = new Map<string, Table>();
  private readonly dir: string;

  constructor(private storage: ModuleStorage, dataDir: string) {
    storage.migrate(MIGRATIONS);
    this.dir = join(dataDir, 'versions');
    mkdirSync(this.dir, { recursive: true });
  }

  private get db() {
    return this.storage.db;
  }

  private file(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new DataError('bad-request', 'Bad id.');
    return join(this.dir, `${id}.json.gz`);
  }

  // ---------------------------------------------------------------- datasets

  createDataset(profileId: string, name: string, meta: { source?: string } = {}): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO data_datasets (id, profile_id, name, created_at, source) VALUES (?, ?, ?, ?, ?)').run(id, profileId, name.slice(0, 200) || 'Untitled dataset', new Date().toISOString(), (meta.source ?? '').slice(0, 2000));
    return id;
  }

  listDatasets(profileId: string): DatasetRow[] {
    const rows = this.db.prepare(`SELECT d.*, (SELECT COUNT(*) FROM data_versions v WHERE v.dataset_id = d.id) AS n,
      (SELECT v.id FROM data_versions v WHERE v.dataset_id = d.id ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1) AS latest
      FROM data_datasets d WHERE d.profile_id = ? ORDER BY d.created_at DESC`).all(profileId) as Record<string, unknown>[];
    return rows.map((r) => ({ id: String(r.id), name: String(r.name), createdAt: String(r.created_at), licence: String(r.licence), source: String(r.source), citation: String(r.citation), notes: String(r.notes), versions: Number(r.n), latestVersionId: (r.latest as string) ?? null }));
  }

  getDataset(profileId: string, id: string): DatasetRow {
    const d = this.listDatasets(profileId).find((x) => x.id === id);
    if (!d) throw new DataError('not-found', 'Dataset not found.');
    return d;
  }

  updateDataset(profileId: string, id: string, patch: Partial<Pick<DatasetRow, 'name' | 'licence' | 'source' | 'citation' | 'notes'>>): void {
    this.getDataset(profileId, id);
    const limits: Record<string, number> = { name: 200, licence: 200, source: 2000, citation: 4000, notes: 20000 };
    for (const [k, max] of Object.entries(limits)) {
      const v = (patch as Record<string, unknown>)[k];
      if (typeof v === 'string') this.db.prepare(`UPDATE data_datasets SET ${k} = ? WHERE id = ?`).run(v.slice(0, max), id);
    }
  }

  deleteDataset(profileId: string, id: string): void {
    this.getDataset(profileId, id);
    for (const v of this.listVersions(id)) {
      this.cache.delete(v.id);
      rmSync(this.file(v.id), { force: true });
      this.db.prepare('DELETE FROM data_runs WHERE version_id = ?').run(v.id);
    }
    this.db.prepare('DELETE FROM data_versions WHERE dataset_id = ?').run(id);
    this.db.prepare('DELETE FROM data_datasets WHERE id = ?').run(id);
  }

  // ---------------------------------------------------------------- versions

  addVersion(datasetId: string, t: Table, info: { parentId?: string | null; label: string; format: string; sourcePath?: string | null; sourceSha256?: string | null; steps?: Step[]; reports?: StepReport[]; notes?: string[]; truncated?: boolean }): VersionRow {
    const id = randomUUID();
    const hash = tableHash(t);
    writeFileSync(this.file(id), gzipSync(JSON.stringify(t)));
    this.db.prepare(`INSERT INTO data_versions (id, dataset_id, parent_id, label, created_at, sha256, source_sha256, format, source_path, rows, cols, steps, reports, notes, truncated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, datasetId, info.parentId ?? null, info.label.slice(0, 200), new Date().toISOString(), hash, info.sourceSha256 ?? null, info.format, info.sourcePath ?? null, rowCount(t), t.columns.length, JSON.stringify(info.steps ?? []), JSON.stringify(info.reports ?? []), JSON.stringify(info.notes ?? []), info.truncated ? 1 : 0);
    this.remember(id, t);
    return this.getVersion(id);
  }

  private toVersion(r: Record<string, unknown>): VersionRow {
    return { id: String(r.id), datasetId: String(r.dataset_id), parentId: (r.parent_id as string) ?? null, label: String(r.label), createdAt: String(r.created_at), sha256: String(r.sha256), sourceSha256: (r.source_sha256 as string) ?? null, format: String(r.format), sourcePath: (r.source_path as string) ?? null, rows: Number(r.rows), cols: Number(r.cols), steps: json(r.steps, []), reports: json(r.reports, []), notes: json(r.notes, []), truncated: Boolean(r.truncated) };
  }

  getVersion(id: string): VersionRow {
    const r = this.db.prepare('SELECT * FROM data_versions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) throw new DataError('not-found', 'Dataset version not found.');
    return this.toVersion(r);
  }

  /** Version, checked to belong to the calling profile. */
  getOwnedVersion(profileId: string, id: string): VersionRow {
    const v = this.getVersion(id);
    this.getDataset(profileId, v.datasetId);
    return v;
  }

  listVersions(datasetId: string): VersionRow[] {
    return (this.db.prepare('SELECT * FROM data_versions WHERE dataset_id = ? ORDER BY created_at, rowid').all(datasetId) as Record<string, unknown>[]).map((r) => this.toVersion(r));
  }

  private remember(id: string, t: Table) {
    this.cache.delete(id);
    this.cache.set(id, t);
    while (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value!);
  }

  loadTable(id: string): Table {
    const hit = this.cache.get(id);
    if (hit) {
      this.remember(id, hit);
      return hit;
    }
    const f = this.file(id);
    if (!existsSync(f)) throw new DataError('not-found', 'The data for this version is missing from disk.');
    const t = JSON.parse(gunzipSync(readFileSync(f)).toString('utf8')) as Table;
    const v = this.getVersion(id);
    if (tableHash(t) !== v.sha256) throw new DataError('integrity', 'This dataset version no longer matches its recorded SHA-256; the file was changed outside AETHER.');
    this.remember(id, t);
    return t;
  }

  // ---------------------------------------------------------------- runs

  addRun(profileId: string, versionId: string, r: { name: string; task: string; model: string; metricName: string; metricValue: number | null; baselineValue: number | null; durationMs: number; config: unknown; result: unknown; imported?: boolean }): string {
    const id = randomUUID();
    const fin = (x: number | null) => (x !== null && Number.isFinite(x) ? x : null);
    this.db.prepare(`INSERT INTO data_runs (id, profile_id, version_id, name, created_at, task, model, metric_name, metric_value, baseline_value, duration_ms, config, result, imported)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, profileId, versionId, r.name.slice(0, 200), new Date().toISOString(), r.task, r.model, r.metricName, fin(r.metricValue), fin(r.baselineValue), Math.round(r.durationMs), JSON.stringify(r.config), JSON.stringify(r.result), r.imported ? 1 : 0);
    return id;
  }

  private toRun(r: Record<string, unknown>): RunRow {
    return { id: String(r.id), versionId: String(r.version_id), name: String(r.name), createdAt: String(r.created_at), task: String(r.task), model: String(r.model), metricName: String(r.metric_name), metricValue: (r.metric_value as number) ?? null, baselineValue: (r.baseline_value as number) ?? null, durationMs: Number(r.duration_ms), notes: String(r.notes), imported: Boolean(r.imported) };
  }

  listRuns(profileId: string, versionIds?: string[]): RunRow[] {
    const rows = this.db.prepare('SELECT * FROM data_runs WHERE profile_id = ? ORDER BY created_at DESC, rowid DESC').all(profileId) as Record<string, unknown>[];
    const runs = rows.map((r) => this.toRun(r));
    return versionIds ? runs.filter((r) => versionIds.includes(r.versionId)) : runs;
  }

  getRun(profileId: string, id: string): RunRow & { config: unknown; result: Record<string, unknown> } {
    const r = this.db.prepare('SELECT * FROM data_runs WHERE id = ? AND profile_id = ?').get(id, profileId) as Record<string, unknown> | undefined;
    if (!r) throw new DataError('not-found', 'Run not found.');
    return { ...this.toRun(r), config: json(r.config, {}), result: json(r.result, {}) };
  }

  updateRun(profileId: string, id: string, patch: { name?: string; notes?: string }): void {
    this.getRun(profileId, id);
    if (typeof patch.name === 'string') this.db.prepare('UPDATE data_runs SET name = ? WHERE id = ?').run(patch.name.slice(0, 200), id);
    if (typeof patch.notes === 'string') this.db.prepare('UPDATE data_runs SET notes = ? WHERE id = ?').run(patch.notes.slice(0, 20000), id);
  }

  deleteRun(profileId: string, id: string): void {
    this.getRun(profileId, id);
    this.db.prepare('DELETE FROM data_runs WHERE id = ?').run(id);
  }

  /** Called on profileDeleted. */
  deleteProfile(profileId: string): void {
    for (const d of this.listDatasets(profileId)) this.deleteDataset(profileId, d.id);
    this.db.prepare('DELETE FROM data_runs WHERE profile_id = ?').run(profileId);
  }
}
