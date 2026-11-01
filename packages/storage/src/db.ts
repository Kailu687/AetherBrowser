import { DatabaseSync } from 'node:sqlite';
import type { ModuleMigration, SqlDatabase } from '@aether/plugin-api';

/**
 * Opens the local database. We use node:sqlite (bundled with Node 22 and
 * Electron 38) so the app ships with no native modules to rebuild. Only the
 * minimal {@link SqlDatabase} shape leaks out, so swapping in better-sqlite3
 * later is a one-file change.
 */
export function openSqlite(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 3000;');
  return db;
}

export function transaction<T>(db: SqlDatabase, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Applies forward-only migrations for one owner (the core schema or a module id). */
export function migrate(db: SqlDatabase, owner: string, migrations: ModuleMigration[]): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    owner TEXT NOT NULL,
    version INTEGER NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (owner, version)
  )`);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations WHERE owner = ?').get(owner) as { v: number | null };
  const current = row?.v ?? 0;
  const pending = [...migrations].sort((a, b) => a.version - b.version).filter((m) => m.version > current);
  for (const m of pending) {
    transaction(db, () => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations (owner, version, applied_at) VALUES (?, ?, ?)').run(owner, m.version, Date.now());
    });
  }
  return pending.length;
}
