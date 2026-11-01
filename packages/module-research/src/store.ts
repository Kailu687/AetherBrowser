import type { ModuleMigration, SqlDatabase } from "@aether/plugin-api";
import { MemoryCollection, type Collection, type Entity, type Id } from "@aether/research-core";
import type { ReadingItem, Evidence, ExtractionItem, GapDecision, LabProject, ResearchQuestion, SavedPage, TrailEntry, VerificationRecord } from "./model.js";
import { normalize, tokens } from "./text.js";

/**
 * Research & Writing module storage. All module data lives in the module's own SQLite file
 * (host.storage.db), in one table partitioned by collection and browser
 * profile. Private windows use in-memory collections only.
 */
export const MODULE_MIGRATIONS: ModuleMigration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS module_research_docs (
        collection TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        id TEXT NOT NULL,
        project_id TEXT,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (collection, profile_id, id)
      );
      CREATE INDEX IF NOT EXISTS module_research_docs_project ON module_research_docs (collection, profile_id, project_id);
    `,
  },
];

type WithProject = Entity & { projectId?: string };

export class SqliteCollection<T extends WithProject> implements Collection<T> {
  constructor(
    private readonly db: SqlDatabase,
    private readonly collection: string,
    private readonly profileId: string,
  ) {}
  async get(id: Id): Promise<T | undefined> {
    const row = this.db.prepare("SELECT json FROM module_research_docs WHERE collection = ? AND profile_id = ? AND id = ?").get(this.collection, this.profileId, id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }
  async list(filter?: (item: T) => boolean): Promise<T[]> {
    const rows = this.db.prepare("SELECT json FROM module_research_docs WHERE collection = ? AND profile_id = ? ORDER BY updated_at DESC").all(this.collection, this.profileId) as Array<{ json: string }>;
    const items = rows.map((r) => JSON.parse(r.json) as T);
    return filter ? items.filter(filter) : items;
  }
  async byProject(projectId: string): Promise<T[]> {
    const rows = this.db.prepare("SELECT json FROM module_research_docs WHERE collection = ? AND profile_id = ? AND project_id = ? ORDER BY updated_at DESC").all(this.collection, this.profileId, projectId) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as T);
  }
  async put(item: T): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO module_research_docs (collection, profile_id, id, project_id, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (collection, profile_id, id) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(this.collection, this.profileId, item.id, item.projectId ?? null, item.updatedAt, JSON.stringify(item));
  }
  async delete(id: Id): Promise<boolean> {
    return Number(this.db.prepare("DELETE FROM module_research_docs WHERE collection = ? AND profile_id = ? AND id = ?").run(this.collection, this.profileId, id).changes) > 0;
  }
  async deleteProject(projectId: string): Promise<number> {
    return Number(this.db.prepare("DELETE FROM module_research_docs WHERE collection = ? AND profile_id = ? AND project_id = ?").run(this.collection, this.profileId, projectId).changes);
  }
  async deleteOlderThan(iso: string): Promise<number> {
    return Number(this.db.prepare("DELETE FROM module_research_docs WHERE collection = ? AND profile_id = ? AND updated_at < ?").run(this.collection, this.profileId, iso).changes);
  }
  async clear(): Promise<number> {
    return Number(this.db.prepare("DELETE FROM module_research_docs WHERE collection = ? AND profile_id = ?").run(this.collection, this.profileId).changes);
  }
}

/** In-memory twin used for private windows and tests. */
export class MemoryProjectCollection<T extends WithProject> extends MemoryCollection<T> {
  async byProject(projectId: string) {
    return this.list((i) => i.projectId === projectId);
  }
  async deleteProject(projectId: string) {
    const items = await this.byProject(projectId);
    for (const i of items) await this.delete(i.id);
    return items.length;
  }
  async deleteOlderThan(iso: string) {
    const items = await this.list((i) => i.updatedAt < iso);
    for (const i of items) await this.delete(i.id);
    return items.length;
  }
  async clear() {
    const items = await this.list();
    for (const i of items) await this.delete(i.id);
    return items.length;
  }
}

export type ModuleCollection<T extends WithProject> = Collection<T> & {
  byProject(projectId: string): Promise<T[]>;
  deleteProject(projectId: string): Promise<number>;
  deleteOlderThan(iso: string): Promise<number>;
  clear(): Promise<number>;
};

export interface ModuleStores {
  projects: ModuleCollection<LabProject>;
  questions: ModuleCollection<ResearchQuestion>;
  evidence: ModuleCollection<Evidence>;
  extractions: ModuleCollection<ExtractionItem>;
  gaps: ModuleCollection<GapDecision>;
  verifications: ModuleCollection<VerificationRecord>;
  saved: ModuleCollection<SavedPage>;
  trail: ModuleCollection<TrailEntry>;
  reading: ModuleCollection<ReadingItem>;
}

export function createStores(db: SqlDatabase | null, profileId: string): ModuleStores {
  const c = <T extends WithProject>(name: string): ModuleCollection<T> => (db ? new SqliteCollection<T>(db, name, profileId) : new MemoryProjectCollection<T>());
  return {
    projects: c("projects"),
    questions: c("questions"),
    evidence: c("evidence"),
    extractions: c("extractions"),
    gaps: c("gaps"),
    verifications: c("verifications"),
    saved: c("saved"),
    trail: c("trail"),
    reading: c("reading"),
  };
}

export function deleteProfile(db: SqlDatabase, profileId: string): number {
  return Number(db.prepare("DELETE FROM module_research_docs WHERE profile_id = ?").run(profileId).changes);
}

// ---------------------------------------------------------------- saved-page search

export interface SearchHit {
  id: string;
  title: string;
  url: string;
  savedAt: string;
  score: number;
  snippet: string;
}

/**
 * Ranked full-text search over saved pages: BM25-style term weighting over
 * title (boosted) and text, plus an exact-phrase bonus. Runs entirely on
 * this device.
 */
export function searchSaved(pages: SavedPage[], query: string, limit = 50): SearchHit[] {
  const q = tokens(query, { stop: true });
  if (!q.length) return [];
  const phrase = normalize(query);
  const docs = pages.map((p) => ({ p, title: tokens(p.title), body: tokens(p.text) }));
  const N = docs.length;
  const avg = docs.reduce((s, d) => s + d.body.length, 0) / Math.max(1, N);
  const df = new Map<string, number>();
  for (const t of q) df.set(t, docs.filter((d) => d.body.includes(t) || d.title.includes(t)).length);
  const hits: SearchHit[] = [];
  for (const d of docs) {
    let score = 0;
    for (const t of q) {
      const n = df.get(t) ?? 0;
      if (!n) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const tf = d.body.filter((x) => x === t).length;
      const tfTitle = d.title.filter((x) => x === t).length;
      score += idf * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (d.body.length / (avg || 1))))) + idf * 2 * tfTitle;
    }
    if (!score) continue;
    const normText = normalize(d.p.text);
    if (phrase.includes(" ") && normText.includes(phrase)) score *= 1.5;
    hits.push({ id: d.p.id, title: d.p.title, url: d.p.url, savedAt: d.p.createdAt, score, snippet: snippet(d.p.text, q) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function snippet(text: string, q: string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of q) {
    at = lower.indexOf(t);
    if (at >= 0) break;
  }
  const start = Math.max(0, at - 80);
  return (start > 0 ? "…" : "") + text.slice(start, start + 240).replace(/\s+/g, " ").trim() + (start + 240 < text.length ? "…" : "");
}
