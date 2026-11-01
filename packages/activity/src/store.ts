import type { ActivitySegment, FocusSessionEntry, InterventionEntry, SegmentQuery } from './types.js';

export interface ActivityStore {
  insertSegment(segment: ActivitySegment): number;
  /** Extends a previously inserted segment (used for checkpoints of a still-open segment). */
  updateSegmentEnd(id: number, end: number): void;
  /** Segments overlapping [from, to). */
  querySegments(q: SegmentQuery): ActivitySegment[];
  insertIntervention(entry: InterventionEntry): void;
  queryInterventions(q: { from: number; to: number }): InterventionEntry[];
  upsertFocusSession(entry: FocusSessionEntry): void;
  queryFocusSessions(q: { from: number; to: number }): FocusSessionEntry[];
  /** Deletes records that started before `before`. */
  deleteBefore(before: number): void;
  deleteRange(from: number, to: number): void;
  deleteDomain(domain: string): void;
  deleteProfile(profileId: string): void;
  deleteAll(): void;
}

export class MemoryActivityStore implements ActivityStore {
  private segments: ActivitySegment[] = [];
  private interventions: InterventionEntry[] = [];
  private sessions = new Map<string, FocusSessionEntry>();
  private nextId = 1;

  insertSegment(s: ActivitySegment): number {
    const id = this.nextId++;
    this.segments.push({ ...s, id });
    return id;
  }
  updateSegmentEnd(id: number, end: number): void {
    const s = this.segments.find((x) => x.id === id);
    if (s) s.end = end;
  }
  querySegments(q: SegmentQuery): ActivitySegment[] {
    return this.segments
      .filter((s) => s.end > q.from && s.start < q.to && (!q.profileId || s.profileId === q.profileId))
      .map((s) => ({ ...s }))
      .sort((a, b) => a.start - b.start);
  }
  insertIntervention(e: InterventionEntry): void {
    this.interventions.push({ ...e, id: this.nextId++ });
  }
  queryInterventions(q: { from: number; to: number }): InterventionEntry[] {
    return this.interventions.filter((e) => e.at >= q.from && e.at < q.to).map((e) => ({ ...e }));
  }
  upsertFocusSession(e: FocusSessionEntry): void {
    this.sessions.set(e.id, { ...e });
  }
  queryFocusSessions(q: { from: number; to: number }): FocusSessionEntry[] {
    return [...this.sessions.values()].filter((s) => s.endedAt > q.from && s.startedAt < q.to).sort((a, b) => a.startedAt - b.startedAt);
  }
  deleteBefore(before: number): void {
    this.segments = this.segments.filter((s) => s.start >= before);
    this.interventions = this.interventions.filter((e) => e.at >= before);
    for (const [k, s] of this.sessions) if (s.startedAt < before) this.sessions.delete(k);
  }
  deleteRange(from: number, to: number): void {
    this.segments = this.segments.filter((s) => s.end <= from || s.start >= to);
    this.interventions = this.interventions.filter((e) => e.at < from || e.at >= to);
    for (const [k, s] of this.sessions) if (s.endedAt > from && s.startedAt < to) this.sessions.delete(k);
  }
  deleteDomain(domain: string): void {
    this.segments = this.segments.filter((s) => s.domain !== domain);
    this.interventions = this.interventions.filter((e) => e.domain !== domain);
  }
  deleteProfile(profileId: string): void {
    this.segments = this.segments.filter((s) => s.profileId !== profileId);
  }
  deleteAll(): void {
    this.segments = [];
    this.interventions = [];
    this.sessions.clear();
  }
}

/** The subset of node:sqlite DatabaseSync / better-sqlite3 that the store uses. */
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { lastInsertRowid: number | bigint };
    all(...params: unknown[]): unknown[];
  };
}

const schema = (p: string) => `
CREATE TABLE IF NOT EXISTS ${p}segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  domain TEXT NOT NULL,
  category TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  workspace_id TEXT
);
CREATE INDEX IF NOT EXISTS ${p}segments_start ON ${p}segments(start_ms);
CREATE INDEX IF NOT EXISTS ${p}segments_end ON ${p}segments(end_ms);
CREATE TABLE IF NOT EXISTS ${p}interventions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  domain TEXT NOT NULL,
  action TEXT NOT NULL,
  resolution TEXT,
  mode TEXT NOT NULL,
  session_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ${p}interventions_at ON ${p}interventions(at_ms);
CREATE TABLE IF NOT EXISTS ${p}focus_sessions (
  id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  goal TEXT NOT NULL,
  started_ms INTEGER NOT NULL,
  ended_ms INTEGER NOT NULL,
  focused_ms INTEGER NOT NULL,
  end_reason TEXT NOT NULL,
  work_blocks INTEGER NOT NULL,
  interventions INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ${p}focus_sessions_start ON ${p}focus_sessions(started_ms);
`;

type Row = Record<string, any>;

/**
 * SQLite-backed store inside the shell's shared database. Tables are named
 * `<prefix>segments`, `<prefix>interventions` and `<prefix>focus_sessions`.
 */
export class SqlActivityStore implements ActivityStore {
  private readonly t: { seg: string; iv: string; fs: string };

  constructor(
    private readonly db: SqlDatabase,
    opts: { tablePrefix?: string } = {},
  ) {
    const p = opts.tablePrefix ?? 'activity_';
    if (!/^[a-z][a-z0-9_]*$/.test(p)) throw new Error(`Invalid table prefix "${p}"`);
    this.t = { seg: `${p}segments`, iv: `${p}interventions`, fs: `${p}focus_sessions` };
    db.exec(schema(p));
  }

  insertSegment(s: ActivitySegment): number {
    const r = this.db
      .prepare(`INSERT INTO ${this.t.seg} (start_ms, end_ms, kind, domain, category, profile_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(s.start, s.end, s.kind, s.domain, s.category, s.profileId, s.workspaceId);
    return Number(r.lastInsertRowid);
  }
  updateSegmentEnd(id: number, end: number): void {
    this.db.prepare(`UPDATE ${this.t.seg} SET end_ms = ? WHERE id = ?`).run(end, id);
  }
  querySegments(q: SegmentQuery): ActivitySegment[] {
    const rows = (
      q.profileId
        ? this.db.prepare(`SELECT * FROM ${this.t.seg} WHERE end_ms > ? AND start_ms < ? AND profile_id = ? ORDER BY start_ms`).all(q.from, q.to, q.profileId)
        : this.db.prepare(`SELECT * FROM ${this.t.seg} WHERE end_ms > ? AND start_ms < ? ORDER BY start_ms`).all(q.from, q.to)
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      start: Number(r.start_ms),
      end: Number(r.end_ms),
      kind: r.kind,
      domain: r.domain,
      category: r.category,
      profileId: r.profile_id,
      workspaceId: r.workspace_id ?? null,
    }));
  }
  insertIntervention(e: InterventionEntry): void {
    this.db
      .prepare(`INSERT INTO ${this.t.iv} (at_ms, domain, action, resolution, mode, session_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(e.at, e.domain, e.action, e.resolution ?? null, e.mode, e.sessionId);
  }
  queryInterventions(q: { from: number; to: number }): InterventionEntry[] {
    return (this.db.prepare(`SELECT * FROM ${this.t.iv} WHERE at_ms >= ? AND at_ms < ? ORDER BY at_ms`).all(q.from, q.to) as Row[]).map((r) => ({
      id: Number(r.id),
      at: Number(r.at_ms),
      domain: r.domain,
      action: r.action,
      resolution: r.resolution ?? undefined,
      mode: r.mode,
      sessionId: r.session_id,
    }));
  }
  upsertFocusSession(e: FocusSessionEntry): void {
    this.db
      .prepare(
        `INSERT INTO ${this.t.fs} (id, mode, goal, started_ms, ended_ms, focused_ms, end_reason, work_blocks, interventions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ended_ms = excluded.ended_ms, focused_ms = excluded.focused_ms, end_reason = excluded.end_reason,
           work_blocks = excluded.work_blocks, interventions = excluded.interventions, goal = excluded.goal`,
      )
      .run(e.id, e.mode, e.goal, e.startedAt, e.endedAt, e.focusedMs, e.endReason, e.completedWorkBlocks, e.interventions);
  }
  queryFocusSessions(q: { from: number; to: number }): FocusSessionEntry[] {
    return (this.db.prepare(`SELECT * FROM ${this.t.fs} WHERE ended_ms > ? AND started_ms < ? ORDER BY started_ms`).all(q.from, q.to) as Row[]).map((r) => ({
      id: r.id,
      mode: r.mode,
      goal: r.goal,
      startedAt: Number(r.started_ms),
      endedAt: Number(r.ended_ms),
      focusedMs: Number(r.focused_ms),
      endReason: r.end_reason,
      completedWorkBlocks: Number(r.work_blocks),
      interventions: Number(r.interventions),
    }));
  }
  deleteBefore(before: number): void {
    this.db.prepare(`DELETE FROM ${this.t.seg} WHERE start_ms < ?`).run(before);
    this.db.prepare(`DELETE FROM ${this.t.iv} WHERE at_ms < ?`).run(before);
    this.db.prepare(`DELETE FROM ${this.t.fs} WHERE started_ms < ?`).run(before);
  }
  deleteRange(from: number, to: number): void {
    this.db.prepare(`DELETE FROM ${this.t.seg} WHERE end_ms > ? AND start_ms < ?`).run(from, to);
    this.db.prepare(`DELETE FROM ${this.t.iv} WHERE at_ms >= ? AND at_ms < ?`).run(from, to);
    this.db.prepare(`DELETE FROM ${this.t.fs} WHERE ended_ms > ? AND started_ms < ?`).run(from, to);
  }
  deleteDomain(domain: string): void {
    this.db.prepare(`DELETE FROM ${this.t.seg} WHERE domain = ?`).run(domain);
    this.db.prepare(`DELETE FROM ${this.t.iv} WHERE domain = ?`).run(domain);
  }
  deleteProfile(profileId: string): void {
    this.db.prepare(`DELETE FROM ${this.t.seg} WHERE profile_id = ?`).run(profileId);
  }
  deleteAll(): void {
    this.db.exec(`DELETE FROM ${this.t.seg}; DELETE FROM ${this.t.iv}; DELETE FROM ${this.t.fs};`);
  }
}
