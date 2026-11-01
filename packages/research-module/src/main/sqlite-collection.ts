import type { SqlDatabase, ModuleMigration } from "@aether/plugin-api";
import type { Collection, Entity, Id } from "@aether/research-core";

/**
 * All research records live in one table, partitioned by collection and
 * browser profile so identities never see each other's notes or library.
 */
export const RESEARCH_MIGRATIONS: ModuleMigration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE IF NOT EXISTS research_docs (
        collection TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        id TEXT NOT NULL,
        workspace_id TEXT,
        updated_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (collection, profile_id, id)
      );
      CREATE INDEX IF NOT EXISTS research_docs_ws ON research_docs (collection, profile_id, workspace_id);
    `,
  },
];

export class SqliteCollection<T extends Entity & { workspaceId?: string }> implements Collection<T> {
  constructor(
    private readonly db: SqlDatabase,
    private readonly collection: string,
    private readonly profileId: string,
  ) {}

  async get(id: Id): Promise<T | undefined> {
    const row = this.db.prepare("SELECT json FROM research_docs WHERE collection = ? AND profile_id = ? AND id = ?").get(this.collection, this.profileId, id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  async list(filter?: (item: T) => boolean): Promise<T[]> {
    const rows = this.db.prepare("SELECT json FROM research_docs WHERE collection = ? AND profile_id = ? ORDER BY updated_at DESC").all(this.collection, this.profileId) as Array<{ json: string }>;
    const items = rows.map((r) => JSON.parse(r.json) as T);
    return filter ? items.filter(filter) : items;
  }

  async put(item: T): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO research_docs (collection, profile_id, id, workspace_id, updated_at, json) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (collection, profile_id, id) DO UPDATE SET workspace_id = excluded.workspace_id, updated_at = excluded.updated_at, json = excluded.json`,
      )
      .run(this.collection, this.profileId, item.id, item.workspaceId ?? null, item.updatedAt, JSON.stringify(item));
  }

  async delete(id: Id): Promise<boolean> {
    const r = this.db.prepare("DELETE FROM research_docs WHERE collection = ? AND profile_id = ? AND id = ?").run(this.collection, this.profileId, id);
    return Number(r.changes) > 0;
  }
}

export function deleteProfileData(db: SqlDatabase, profileId: string): number {
  return Number(db.prepare("DELETE FROM research_docs WHERE profile_id = ?").run(profileId).changes);
}
