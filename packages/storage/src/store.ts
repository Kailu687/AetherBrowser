import { randomUUID } from 'node:crypto';
import type { ModuleMigration, ModuleStorage, SqlDatabase } from '@aether/plugin-api';
import { migrate, openSqlite, transaction } from './db';
import { CORE_MIGRATIONS } from './schema';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export type CloseBehavior = 'ask' | 'save' | 'discard';

export interface Profile {
  id: string;
  name: string;
  color: string;
  icon: string;
  searchEngine: string;
  downloadDir: string | null;
  askDownloadLocation: boolean;
  closeBehavior: CloseBehavior;
  restoreOnStartup: boolean;
  sortOrder: number;
  createdAt: number;
}

export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  visitCount: number;
  typedCount: number;
  lastVisitAt: number;
}

export interface Bookmark {
  id: number;
  parentId: number | null;
  title: string;
  url: string | null;
  position: number;
  createdAt: number;
}

export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted';

export interface DownloadRecord {
  id: number;
  url: string;
  filename: string;
  path: string;
  mime: string;
  totalBytes: number;
  receivedBytes: number;
  state: DownloadState;
  startedAt: number;
  endedAt: number | null;
}

/** A tab as persisted in workspaces and window sessions. */
export interface SavedTab {
  url: string;
  title: string;
  /** Vertical scroll offset in CSS px, restored after load ("reading position"). */
  scrollY?: number;
  pinned?: boolean;
  /** Split-view pane this tab was shown in, if any. */
  pane?: 'left' | 'right';
  /** Tab group (the group's details are repeated on each member tab). */
  group?: { id: string; title: string; color: string; collapsed?: boolean };
}

export interface Workspace {
  id: string;
  profileId: string;
  name: string;
  color: string;
  icon: string;
  notes: string;
  tabs: SavedTab[];
  activeIndex: number;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowSession {
  id: string;
  profileId: string;
  workspaceId: string | null;
  state: 'open' | 'saved';
  title: string;
  bounds: Bounds | null;
  maximized: boolean;
  tabs: SavedTab[];
  activeIndex: number;
  split: { left: number; right: number; ratio: number } | null;
  updatedAt: number;
}

export const PROFILE_COLORS = ['#7c8cff', '#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#f87171', '#a78bfa', '#2dd4bf'];

const json = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const MAX_URL_LENGTH = 8192;
const MAX_TITLE_LENGTH = 1024;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Only ordinary web pages go into history (no internal, file, data or blob URLs). */
export function isHistoryWorthy(url: string): boolean {
  return /^https?:\/\//i.test(url) && url.length <= MAX_URL_LENGTH;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class AetherStore {
  readonly db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.db = db;
    migrate(db, 'core', CORE_MIGRATIONS);
  }

  static open(path: string): AetherStore {
    return new AetherStore(openSqlite(path) as unknown as SqlDatabase);
  }

  close(): void {
    (this.db as unknown as { close?: () => void }).close?.();
  }

  // ---- profiles -----------------------------------------------------------

  private mapProfile = (r: any): Profile => ({
    id: r.id,
    name: r.name,
    color: r.color,
    icon: r.icon,
    searchEngine: r.search_engine,
    downloadDir: r.download_dir ?? null,
    askDownloadLocation: !!r.ask_download_location,
    closeBehavior: r.close_behavior,
    restoreOnStartup: !!r.restore_on_startup,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
  });

  listProfiles(): Profile[] {
    return this.db.prepare('SELECT * FROM profiles ORDER BY sort_order, created_at').all().map(this.mapProfile);
  }

  getProfile(id: string): Profile | null {
    const r = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    return r ? this.mapProfile(r) : null;
  }

  createProfile(input: { name: string; color?: string; icon?: string; searchEngine?: string }): Profile {
    const id = randomUUID();
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM profiles').get() as { n: number }).n;
    const name = clip(input.name.trim() || 'Profile', 64);
    this.db
      .prepare('INSERT INTO profiles (id, name, color, icon, search_engine, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, input.color ?? PROFILE_COLORS[count % PROFILE_COLORS.length], input.icon ?? '', input.searchEngine ?? 'google', count, Date.now());
    return this.getProfile(id)!;
  }

  updateProfile(id: string, patch: Partial<Pick<Profile, 'name' | 'color' | 'icon' | 'searchEngine' | 'downloadDir' | 'askDownloadLocation' | 'closeBehavior' | 'restoreOnStartup'>>): Profile | null {
    const cols: Record<string, unknown> = {};
    if (patch.name !== undefined) cols.name = clip(patch.name.trim() || 'Profile', 64);
    if (patch.color !== undefined) cols.color = patch.color;
    if (patch.icon !== undefined) cols.icon = patch.icon;
    if (patch.searchEngine !== undefined) cols.search_engine = patch.searchEngine;
    if (patch.downloadDir !== undefined) cols.download_dir = patch.downloadDir;
    if (patch.askDownloadLocation !== undefined) cols.ask_download_location = patch.askDownloadLocation ? 1 : 0;
    if (patch.closeBehavior !== undefined) cols.close_behavior = patch.closeBehavior;
    if (patch.restoreOnStartup !== undefined) cols.restore_on_startup = patch.restoreOnStartup ? 1 : 0;
    const keys = Object.keys(cols);
    if (keys.length) {
      this.db.prepare(`UPDATE profiles SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), id);
    }
    return this.getProfile(id);
  }

  /** Counts of what deleting a profile removes, shown to the user before confirming. */
  profileDataSummary(id: string): { history: number; bookmarks: number; downloads: number; workspaces: number; windows: number } {
    const n = (sql: string) => (this.db.prepare(sql).get(id) as { n: number }).n;
    return {
      history: n('SELECT COUNT(*) AS n FROM history_entries WHERE profile_id = ?'),
      bookmarks: n('SELECT COUNT(*) AS n FROM bookmarks WHERE profile_id = ? AND url IS NOT NULL'),
      downloads: n('SELECT COUNT(*) AS n FROM downloads WHERE profile_id = ?'),
      workspaces: n('SELECT COUNT(*) AS n FROM workspaces WHERE profile_id = ?'),
      windows: n('SELECT COUNT(*) AS n FROM window_sessions WHERE profile_id = ?'),
    };
  }

  deleteProfile(id: string): void {
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM module_kv WHERE profile_id = ?').run(id);
      this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    });
  }

  /** Exports the data AETHER itself stores for a profile (cookies and site storage stay in the engine). */
  exportProfile(id: string): object | null {
    const profile = this.getProfile(id);
    if (!profile) return null;
    return {
      format: 'aether-profile-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      profile,
      bookmarks: this.db.prepare('SELECT id, parent_id AS parentId, title, url, position, created_at AS createdAt FROM bookmarks WHERE profile_id = ? ORDER BY parent_id, position').all(id),
      history: this.db.prepare('SELECT url, title, visit_count AS visitCount, last_visit_at AS lastVisitAt FROM history_entries WHERE profile_id = ? ORDER BY last_visit_at DESC').all(id),
      workspaces: this.listWorkspaces(id, true),
      downloads: this.listDownloads(id, 10_000),
    };
  }

  // ---- history ------------------------------------------------------------

  recordVisit(profileId: string, url: string, title: string, transition: 'link' | 'typed' | 'reload' = 'link'): void {
    if (!isHistoryWorthy(url)) return;
    const now = Date.now();
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO history_entries (profile_id, url, title, visit_count, typed_count, last_visit_at)
           VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT (profile_id, url) DO UPDATE SET
             visit_count = visit_count + 1,
             typed_count = typed_count + excluded.typed_count,
             last_visit_at = excluded.last_visit_at,
             title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END`,
        )
        .run(profileId, url, clip(title, MAX_TITLE_LENGTH), transition === 'typed' ? 1 : 0, now);
      const entry = this.db.prepare('SELECT id FROM history_entries WHERE profile_id = ? AND url = ?').get(profileId, url) as { id: number };
      this.db.prepare('INSERT INTO history_visits (entry_id, visited_at, transition) VALUES (?, ?, ?)').run(entry.id, now, transition);
    });
  }

  updateHistoryTitle(profileId: string, url: string, title: string): void {
    if (!title) return;
    this.db.prepare('UPDATE history_entries SET title = ? WHERE profile_id = ? AND url = ?').run(clip(title, MAX_TITLE_LENGTH), profileId, url);
  }

  private mapHistory = (r: any): HistoryEntry => ({
    id: r.id,
    url: r.url,
    title: r.title,
    visitCount: r.visit_count,
    typedCount: r.typed_count,
    lastVisitAt: r.last_visit_at,
  });

  listHistory(profileId: string, opts: { query?: string; limit?: number; before?: number } = {}): HistoryEntry[] {
    const limit = Math.min(opts.limit ?? 100, 1000);
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    if (opts.query) {
      const like = `%${opts.query.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
      return this.db
        .prepare(`SELECT * FROM history_entries WHERE profile_id = ? AND last_visit_at < ? AND (url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') ORDER BY last_visit_at DESC LIMIT ?`)
        .all(profileId, before, like, like, limit)
        .map(this.mapHistory);
    }
    return this.db.prepare('SELECT * FROM history_entries WHERE profile_id = ? AND last_visit_at < ? ORDER BY last_visit_at DESC LIMIT ?').all(profileId, before, limit).map(this.mapHistory);
  }

  /**
   * Address-bar suggestions: prefix matches on host/url and word matches on
   * title, ranked by a frecency score (typed visits weigh more, decays with age).
   */
  suggest(profileId: string, input: string, limit = 6): HistoryEntry[] {
    const q = input.trim().toLowerCase();
    if (!q) return [];
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const rows = this.db
      .prepare(`SELECT * FROM history_entries WHERE profile_id = ? AND (url LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\') ORDER BY last_visit_at DESC LIMIT 200`)
      .all(profileId, like, like)
      .map(this.mapHistory);
    const now = Date.now();
    const score = (e: HistoryEntry) => {
      const ageDays = (now - e.lastVisitAt) / 86_400_000;
      const recency = ageDays < 1 ? 100 : ageDays < 7 ? 70 : ageDays < 30 ? 50 : ageDays < 90 ? 30 : 10;
      const bare = e.url.replace(/^https?:\/\/(www\.)?/, '').toLowerCase();
      const prefix = bare.startsWith(q) ? 2 : 1;
      return (e.visitCount + e.typedCount * 2) * recency * prefix;
    };
    return rows.sort((a, b) => score(b) - score(a)).slice(0, limit);
  }

  deleteHistoryEntry(profileId: string, id: number): void {
    this.db.prepare('DELETE FROM history_entries WHERE profile_id = ? AND id = ?').run(profileId, id);
  }

  clearHistory(profileId: string, since?: number): void {
    if (since === undefined) {
      this.db.prepare('DELETE FROM history_entries WHERE profile_id = ?').run(profileId);
      return;
    }
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM history_visits WHERE visited_at >= ? AND entry_id IN (SELECT id FROM history_entries WHERE profile_id = ?)').run(since, profileId);
      this.db.prepare('DELETE FROM history_entries WHERE profile_id = ? AND id NOT IN (SELECT DISTINCT entry_id FROM history_visits)').run(profileId);
    });
  }

  topSites(profileId: string, limit = 8): HistoryEntry[] {
    return this.db
      .prepare('SELECT * FROM history_entries WHERE profile_id = ? AND last_visit_at > ? ORDER BY (visit_count + typed_count * 2) DESC LIMIT ?')
      .all(profileId, Date.now() - 30 * 86_400_000, limit)
      .map(this.mapHistory);
  }

  // ---- bookmarks ----------------------------------------------------------

  private mapBookmark = (r: any): Bookmark => ({ id: r.id, parentId: r.parent_id ?? null, title: r.title, url: r.url ?? null, position: r.position, createdAt: r.created_at });

  listBookmarks(profileId: string, parentId: number | null = null): Bookmark[] {
    const sql = parentId === null ? 'SELECT * FROM bookmarks WHERE profile_id = ? AND parent_id IS NULL ORDER BY position' : 'SELECT * FROM bookmarks WHERE profile_id = ? AND parent_id = ? ORDER BY position';
    const rows = parentId === null ? this.db.prepare(sql).all(profileId) : this.db.prepare(sql).all(profileId, parentId);
    return rows.map(this.mapBookmark);
  }

  allBookmarks(profileId: string): Bookmark[] {
    return this.db.prepare('SELECT * FROM bookmarks WHERE profile_id = ? ORDER BY parent_id, position').all(profileId).map(this.mapBookmark);
  }

  findBookmarkByUrl(profileId: string, url: string): Bookmark | null {
    const r = this.db.prepare('SELECT * FROM bookmarks WHERE profile_id = ? AND url = ? LIMIT 1').get(profileId, url);
    return r ? this.mapBookmark(r) : null;
  }

  addBookmark(profileId: string, input: { title: string; url: string | null; parentId?: number | null }): Bookmark {
    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      const parent = this.db.prepare('SELECT url FROM bookmarks WHERE id = ? AND profile_id = ?').get(parentId, profileId) as { url: string | null } | undefined;
      if (!parent || parent.url !== null) throw new Error('Parent must be a folder in the same profile');
    }
    const pos = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM bookmarks WHERE profile_id = ? AND parent_id IS ?').get(profileId, parentId) as { p: number }).p;
    const res = this.db
      .prepare('INSERT INTO bookmarks (profile_id, parent_id, title, url, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(profileId, parentId, clip(input.title || input.url || 'Untitled', MAX_TITLE_LENGTH), input.url ? clip(input.url, MAX_URL_LENGTH) : null, pos, Date.now());
    return this.mapBookmark(this.db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(Number(res.lastInsertRowid)));
  }

  updateBookmark(profileId: string, id: number, patch: { title?: string; url?: string }): void {
    if (patch.title !== undefined) this.db.prepare('UPDATE bookmarks SET title = ? WHERE id = ? AND profile_id = ?').run(clip(patch.title, MAX_TITLE_LENGTH), id, profileId);
    if (patch.url !== undefined) this.db.prepare('UPDATE bookmarks SET url = ? WHERE id = ? AND profile_id = ? AND url IS NOT NULL').run(clip(patch.url, MAX_URL_LENGTH), id, profileId);
  }

  deleteBookmark(profileId: string, id: number): void {
    this.db.prepare('DELETE FROM bookmarks WHERE id = ? AND profile_id = ?').run(id, profileId);
  }

  // ---- downloads ----------------------------------------------------------

  private mapDownload = (r: any): DownloadRecord => ({
    id: r.id,
    url: r.url,
    filename: r.filename,
    path: r.path,
    mime: r.mime,
    totalBytes: r.total_bytes,
    receivedBytes: r.received_bytes,
    state: r.state,
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
  });

  addDownload(profileId: string, d: { url: string; filename: string; path: string; mime: string; totalBytes: number }): number {
    const res = this.db
      .prepare('INSERT INTO downloads (profile_id, url, filename, path, mime, total_bytes, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(profileId, clip(d.url, MAX_URL_LENGTH), d.filename, d.path, d.mime, d.totalBytes, Date.now());
    return Number(res.lastInsertRowid);
  }

  updateDownload(id: number, patch: { receivedBytes?: number; totalBytes?: number; state?: DownloadState; path?: string }): void {
    const cols: Record<string, unknown> = {};
    if (patch.receivedBytes !== undefined) cols.received_bytes = patch.receivedBytes;
    if (patch.totalBytes !== undefined) cols.total_bytes = patch.totalBytes;
    if (patch.path !== undefined) cols.path = patch.path;
    if (patch.state !== undefined) {
      cols.state = patch.state;
      if (patch.state !== 'progressing') cols.ended_at = Date.now();
    }
    const keys = Object.keys(cols);
    if (!keys.length) return;
    this.db.prepare(`UPDATE downloads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), id);
  }

  listDownloads(profileId: string, limit = 100): DownloadRecord[] {
    return this.db.prepare('SELECT * FROM downloads WHERE profile_id = ? ORDER BY started_at DESC LIMIT ?').all(profileId, limit).map(this.mapDownload);
  }

  getDownload(id: number): (DownloadRecord & { profileId: string }) | null {
    const r = this.db.prepare('SELECT * FROM downloads WHERE id = ?').get(id) as any;
    return r ? { ...this.mapDownload(r), profileId: r.profile_id } : null;
  }

  clearDownloads(profileId: string): void {
    this.db.prepare("DELETE FROM downloads WHERE profile_id = ? AND state <> 'progressing'").run(profileId);
  }

  /** Downloads still marked in progress after a crash or quit are interrupted. */
  markStaleDownloadsInterrupted(): void {
    this.db.prepare("UPDATE downloads SET state = 'interrupted', ended_at = ? WHERE state = 'progressing'").run(Date.now());
  }

  // ---- workspaces ---------------------------------------------------------

  private mapWorkspace = (r: any): Workspace => ({
    id: r.id,
    profileId: r.profile_id,
    name: r.name,
    color: r.color,
    icon: r.icon,
    notes: r.notes,
    tabs: json<SavedTab[]>(r.tabs_json, []),
    activeIndex: r.active_index,
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  listWorkspaces(profileId: string, includeArchived = false): Workspace[] {
    const sql = includeArchived ? 'SELECT * FROM workspaces WHERE profile_id = ? ORDER BY updated_at DESC' : 'SELECT * FROM workspaces WHERE profile_id = ? AND archived = 0 ORDER BY updated_at DESC';
    return this.db.prepare(sql).all(profileId).map(this.mapWorkspace);
  }

  getWorkspace(id: string): Workspace | null {
    const r = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
    return r ? this.mapWorkspace(r) : null;
  }

  createWorkspace(profileId: string, input: { name: string; color?: string; icon?: string; tabs?: SavedTab[]; activeIndex?: number }): Workspace {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO workspaces (id, profile_id, name, color, icon, tabs_json, active_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, profileId, clip(input.name.trim() || 'Workspace', 80), input.color ?? '#7c8cff', input.icon ?? '', JSON.stringify(input.tabs ?? []), input.activeIndex ?? 0, now, now);
    return this.getWorkspace(id)!;
  }

  updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'name' | 'color' | 'icon' | 'notes' | 'tabs' | 'activeIndex' | 'archived'>>): Workspace | null {
    const cols: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) cols.name = clip(patch.name.trim() || 'Workspace', 80);
    if (patch.color !== undefined) cols.color = patch.color;
    if (patch.icon !== undefined) cols.icon = patch.icon;
    if (patch.notes !== undefined) cols.notes = clip(patch.notes, 200_000);
    if (patch.tabs !== undefined) cols.tabs_json = JSON.stringify(patch.tabs);
    if (patch.activeIndex !== undefined) cols.active_index = patch.activeIndex;
    if (patch.archived !== undefined) cols.archived = patch.archived ? 1 : 0;
    const keys = Object.keys(cols);
    this.db.prepare(`UPDATE workspaces SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k]), id);
    return this.getWorkspace(id);
  }

  deleteWorkspace(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  // ---- window sessions ----------------------------------------------------

  private mapSession = (r: any): WindowSession => ({
    id: r.id,
    profileId: r.profile_id,
    workspaceId: r.workspace_id ?? null,
    state: r.state,
    title: r.title,
    bounds: json<Bounds | null>(r.bounds_json, null),
    maximized: !!r.maximized,
    tabs: json<SavedTab[]>(r.tabs_json, []),
    activeIndex: r.active_index,
    split: json(r.split_json, null),
    updatedAt: r.updated_at,
  });

  saveWindowSession(s: Omit<WindowSession, 'updatedAt'>): void {
    this.db
      .prepare(
        `INSERT INTO window_sessions (id, profile_id, workspace_id, state, title, bounds_json, maximized, tabs_json, active_index, split_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           profile_id = excluded.profile_id, workspace_id = excluded.workspace_id, state = excluded.state, title = excluded.title,
           bounds_json = excluded.bounds_json, maximized = excluded.maximized, tabs_json = excluded.tabs_json,
           active_index = excluded.active_index, split_json = excluded.split_json, updated_at = excluded.updated_at`,
      )
      .run(
        s.id,
        s.profileId,
        s.workspaceId,
        s.state,
        clip(s.title, 200),
        s.bounds ? JSON.stringify(s.bounds) : null,
        s.maximized ? 1 : 0,
        JSON.stringify(s.tabs),
        s.activeIndex,
        s.split ? JSON.stringify(s.split) : null,
        Date.now(),
      );
  }

  listWindowSessions(profileId?: string, state?: 'open' | 'saved'): WindowSession[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (profileId) {
      where.push('profile_id = ?');
      params.push(profileId);
    }
    if (state) {
      where.push('state = ?');
      params.push(state);
    }
    const sql = `SELECT * FROM window_sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`;
    return this.db.prepare(sql).all(...params).map(this.mapSession);
  }

  getWindowSession(id: string): WindowSession | null {
    const r = this.db.prepare('SELECT * FROM window_sessions WHERE id = ?').get(id);
    return r ? this.mapSession(r) : null;
  }

  deleteWindowSession(id: string): void {
    this.db.prepare('DELETE FROM window_sessions WHERE id = ?').run(id);
  }

  // ---- site permissions ---------------------------------------------------

  getPermission(profileId: string, origin: string, permission: string): 'allow' | 'deny' | null {
    const r = this.db.prepare('SELECT decision FROM site_permissions WHERE profile_id = ? AND origin = ? AND permission = ?').get(profileId, origin, permission) as { decision: 'allow' | 'deny' } | undefined;
    return r?.decision ?? null;
  }

  setPermission(profileId: string, origin: string, permission: string, decision: 'allow' | 'deny' | null): void {
    if (decision === null) {
      this.db.prepare('DELETE FROM site_permissions WHERE profile_id = ? AND origin = ? AND permission = ?').run(profileId, origin, permission);
      return;
    }
    this.db
      .prepare('INSERT INTO site_permissions (profile_id, origin, permission, decision, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (profile_id, origin, permission) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at')
      .run(profileId, origin, permission, decision, Date.now());
  }

  listPermissions(profileId: string): { origin: string; permission: string; decision: 'allow' | 'deny' }[] {
    return this.db.prepare('SELECT origin, permission, decision FROM site_permissions WHERE profile_id = ? ORDER BY origin, permission').all(profileId) as any[];
  }

  // ---- settings -----------------------------------------------------------

  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').get(key) as { value_json: string } | undefined;
    return r ? json<T>(r.value_json, fallback) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json').run(key, JSON.stringify(value));
  }

  // ---- module storage -----------------------------------------------------

  moduleStorage(moduleId: string): ModuleStorage {
    const db = this.db;
    return {
      db,
      migrate: (migrations: ModuleMigration[]) => {
        migrate(db, `module:${moduleId}`, migrations);
      },
      kv: {
        get: <T>(key: string, profileId = '') => {
          const r = db.prepare('SELECT value_json FROM module_kv WHERE module_id = ? AND profile_id = ? AND key = ?').get(moduleId, profileId, key) as { value_json: string } | undefined;
          return r ? json<T | undefined>(r.value_json, undefined) : undefined;
        },
        set: (key: string, value: unknown, profileId = '') => {
          db.prepare('INSERT INTO module_kv (module_id, profile_id, key, value_json) VALUES (?, ?, ?, ?) ON CONFLICT (module_id, profile_id, key) DO UPDATE SET value_json = excluded.value_json').run(
            moduleId,
            profileId,
            key,
            JSON.stringify(value),
          );
        },
        delete: (key: string, profileId = '') => {
          db.prepare('DELETE FROM module_kv WHERE module_id = ? AND profile_id = ? AND key = ?').run(moduleId, profileId, key);
        },
      },
    };
  }
}
