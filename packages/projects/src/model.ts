import type { ModuleMigration, SqlDatabase } from '@aether/plugin-api';

export type ItemKind = 'tab' | 'source' | 'document' | 'code' | 'schematic' | 'dataset' | 'note' | 'file' | 'result' | 'link';
export type Status = 'satisfied' | 'violated' | 'unknown';
export type Operator = '<=' | '>=' | '<' | '>' | '=' | 'between';

export interface Project { id: string; name: string; description: string; color: string; workspaceId: string | null; createdAt: number; updatedAt: number }
export interface ProjectItem { id: string; projectId: string; kind: ItemKind; title: string; ref: string; app: string | null; meta: Record<string, unknown>; addedAt: number }
export interface Task { id: string; projectId: string; title: string; status: 'todo' | 'doing' | 'done'; due: string | null; createdAt: number }
export interface Decision { id: string; projectId: string; title: string; rationale: string; alternatives: string; itemIds: string[]; decidedAt: number }
export interface Requirement { id: string; projectId: string; name: string; parameter: string; operator: Operator; target: number; target2: number | null; unit: string; notes: string; createdAt: number }
/**
 * How far a piece of evidence has got. Only `measured`, `reviewed` and
 * `verified` evidence can make a requirement "satisfied"; proposals,
 * calculations and simulations are shown but never count as proof.
 */
export type Evidence = 'proposed' | 'calculated' | 'simulated' | 'measured' | 'reviewed' | 'verified';
export const EVIDENCE_LEVELS: Evidence[] = ['proposed', 'calculated', 'simulated', 'measured', 'reviewed', 'verified'];
export const PROVING: Evidence[] = ['measured', 'reviewed', 'verified'];

/** One piece of evidence about a requirement: where the number came from and whether it passes. */
export interface Validation { id: string; requirementId: string; value: number | null; unit: string; source: 'datasheet' | 'simulation' | 'measurement' | 'calculation' | 'other'; sourceRef: string; sourceItemId: string | null; verified: boolean; evidence: Evidence; status: Status; note: string; recordedAt: number; /** The item it came from changed after it was recorded. */ stale: boolean; staleReason: string | null }
/** A traceability link, e.g. requirement → decision, component item → datasheet item, code item → hardware item. */
export interface Link { id: string; projectId: string; from: string; to: string; note: string; createdAt: number }
export interface Change { id: string; projectId: string; itemId: string | null; summary: string; impacted: string[]; at: number }

export const PROJECT_MIGRATIONS: ModuleMigration[] = [
  {
    version: 1,
    up: `CREATE TABLE aether_projects (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL, workspace_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE aether_projects_items (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, ref TEXT NOT NULL, app TEXT, meta TEXT NOT NULL DEFAULT '{}', added_at INTEGER NOT NULL);
CREATE INDEX aether_projects_items_p ON aether_projects_items(project_id);
CREATE TABLE aether_projects_tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, due TEXT, created_at INTEGER NOT NULL);
CREATE TABLE aether_projects_decisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL, alternatives TEXT NOT NULL, item_ids TEXT NOT NULL, decided_at INTEGER NOT NULL);
CREATE TABLE aether_projects_reqs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, parameter TEXT NOT NULL, operator TEXT NOT NULL, target REAL NOT NULL, target2 REAL, unit TEXT NOT NULL, notes TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE aether_projects_validations (id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, value REAL, unit TEXT NOT NULL, source TEXT NOT NULL, source_ref TEXT NOT NULL, source_item_id TEXT, verified INTEGER NOT NULL, note TEXT NOT NULL, recorded_at INTEGER NOT NULL);`,
  },
  {
    version: 2,
    up: `ALTER TABLE aether_projects_validations ADD COLUMN evidence TEXT NOT NULL DEFAULT 'proposed';
UPDATE aether_projects_validations SET evidence = CASE WHEN verified = 1 THEN 'verified' WHEN source = 'measurement' THEN 'measured' WHEN source = 'simulation' THEN 'simulated' WHEN source = 'calculation' THEN 'calculated' ELSE 'proposed' END;
ALTER TABLE aether_projects_validations ADD COLUMN stale_reason TEXT;
CREATE TABLE aether_projects_links (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_ref TEXT NOT NULL, to_ref TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX aether_projects_links_p ON aether_projects_links(project_id);
CREATE TABLE aether_projects_changes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, item_id TEXT, summary TEXT NOT NULL, impacted TEXT NOT NULL, at INTEGER NOT NULL);`,
  },
];

const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** SI prefixes so "500 mA" can be compared with "0.5 A". */
const PREFIX: Record<string, number> = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9 };
export function toBase(value: number, unit: string): { value: number; unit: string } {
  const u = unit.trim();
  const m = u.match(/^([pnuµmkKMG]?)(V|A|W|Hz|Ω|ohm|F|H|s|g|m|Pa|N|B|bps|°C|C|%|dB|dBm)$/);
  if (!m) return { value, unit: u };
  if (['°C', '%', 'dB', 'dBm'].includes(m[2])) return { value, unit: m[2] };
  return { value: value * (PREFIX[m[1]] ?? 1), unit: m[2] === 'ohm' ? 'Ω' : m[2] };
}

/** Is `value` (with its unit) within the requirement? Unknown when there is no value or the units don't match. */
export function evaluate(req: Pick<Requirement, 'operator' | 'target' | 'target2' | 'unit'>, value: number | null, unit: string): Status {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  const v = toBase(value, unit || req.unit);
  const t = toBase(req.target, req.unit);
  if (v.unit !== t.unit) return 'unknown';
  const t2 = req.target2 === null ? null : toBase(req.target2, req.unit).value;
  const eps = Math.abs(t.value) * 1e-9;
  switch (req.operator) {
    case '<=': return v.value <= t.value + eps ? 'satisfied' : 'violated';
    case '>=': return v.value >= t.value - eps ? 'satisfied' : 'violated';
    case '<': return v.value < t.value ? 'satisfied' : 'violated';
    case '>': return v.value > t.value ? 'satisfied' : 'violated';
    case '=': return Math.abs(v.value - t.value) <= Math.max(eps, Math.abs(t.value) * 0.01) ? 'satisfied' : 'violated';
    case 'between': return t2 === null ? 'unknown' : v.value >= Math.min(t.value, t2) && v.value <= Math.max(t.value, t2) ? 'satisfied' : 'violated';
  }
}

/**
 * Overall status of a requirement: violated if any current evidence violates it;
 * satisfied only if current measured/reviewed/verified evidence satisfies it.
 * Stale evidence (its source changed) never proves anything.
 */
export function rollup(vals: Validation[]): Status {
  const current = vals.filter((v) => !v.stale);
  if (current.some((v) => v.status === 'violated')) return 'violated';
  if (current.some((v) => v.status === 'satisfied' && PROVING.includes(v.evidence))) return 'satisfied';
  return 'unknown';
}

const isEvidence = (e: unknown): e is Evidence => typeof e === 'string' && (EVIDENCE_LEVELS as string[]).includes(e);

export class ProjectStore {
  constructor(private db: SqlDatabase, private now: () => number = Date.now) {}

  private own(profileId: string, projectId: string) {
    const r = this.db.prepare('SELECT id FROM aether_projects WHERE id=? AND profile_id=?').get(projectId, profileId);
    if (!r) throw new Error('Project not found');
  }
  private touch(projectId: string) {
    this.db.prepare('UPDATE aether_projects SET updated_at=? WHERE id=?').run(this.now(), projectId);
  }

  list(profileId: string): (Project & { counts: Record<string, number> })[] {
    const rows = this.db.prepare('SELECT * FROM aether_projects WHERE profile_id=? ORDER BY updated_at DESC').all(profileId) as Record<string, unknown>[];
    return rows.map((r) => ({
      ...mapProject(r),
      counts: {
        items: Number((this.db.prepare('SELECT COUNT(*) n FROM aether_projects_items WHERE project_id=?').get(r.id) as { n: number }).n),
        open: Number((this.db.prepare("SELECT COUNT(*) n FROM aether_projects_tasks WHERE project_id=? AND status!='done'").get(r.id) as { n: number }).n),
      },
    }));
  }

  create(profileId: string, input: { name: string; description?: string; color?: string; workspaceId?: string | null }): Project {
    const t = this.now();
    const p: Project = { id: rid(), name: input.name.slice(0, 200) || 'Untitled project', description: (input.description ?? '').slice(0, 5000), color: input.color ?? '#8b7dff', workspaceId: input.workspaceId ?? null, createdAt: t, updatedAt: t };
    this.db.prepare('INSERT INTO aether_projects VALUES (?,?,?,?,?,?,?,?)').run(p.id, profileId, p.name, p.description, p.color, p.workspaceId, t, t);
    return p;
  }

  update(profileId: string, id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'color' | 'workspaceId'>>): void {
    this.own(profileId, id);
    const cur = mapProject(this.db.prepare('SELECT * FROM aether_projects WHERE id=?').get(id) as Record<string, unknown>);
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE aether_projects SET name=?,description=?,color=?,workspace_id=?,updated_at=? WHERE id=?').run(n.name, n.description, n.color, n.workspaceId, this.now(), id);
  }

  delete(profileId: string, id: string): void {
    this.own(profileId, id);
    const reqs = this.db.prepare('SELECT id FROM aether_projects_reqs WHERE project_id=?').all(id) as { id: string }[];
    for (const r of reqs) this.db.prepare('DELETE FROM aether_projects_validations WHERE requirement_id=?').run(r.id);
    for (const t of ['aether_projects_items', 'aether_projects_tasks', 'aether_projects_decisions', 'aether_projects_reqs', 'aether_projects_links', 'aether_projects_changes']) this.db.prepare(`DELETE FROM ${t} WHERE project_id=?`).run(id);
    this.db.prepare('DELETE FROM aether_projects WHERE id=?').run(id);
  }

  deleteProfile(profileId: string) {
    for (const p of this.list(profileId)) this.delete(profileId, p.id);
  }

  get(profileId: string, id: string) {
    this.own(profileId, id);
    const project = mapProject(this.db.prepare('SELECT * FROM aether_projects WHERE id=?').get(id) as Record<string, unknown>);
    const items = (this.db.prepare('SELECT * FROM aether_projects_items WHERE project_id=? ORDER BY added_at DESC').all(id) as Record<string, unknown>[]).map(mapItem);
    const tasks = (this.db.prepare('SELECT * FROM aether_projects_tasks WHERE project_id=? ORDER BY created_at').all(id) as Record<string, unknown>[]).map((r) => ({ id: String(r.id), projectId: id, title: String(r.title), status: r.status as Task['status'], due: (r.due as string) ?? null, createdAt: Number(r.created_at) }));
    const decisions = (this.db.prepare('SELECT * FROM aether_projects_decisions WHERE project_id=? ORDER BY decided_at DESC').all(id) as Record<string, unknown>[]).map((r) => ({ id: String(r.id), projectId: id, title: String(r.title), rationale: String(r.rationale), alternatives: String(r.alternatives), itemIds: JSON.parse(String(r.item_ids)) as string[], decidedAt: Number(r.decided_at) }));
    const requirements = (this.db.prepare('SELECT * FROM aether_projects_reqs WHERE project_id=? ORDER BY created_at').all(id) as Record<string, unknown>[]).map((r) => {
      const req: Requirement = { id: String(r.id), projectId: id, name: String(r.name), parameter: String(r.parameter), operator: r.operator as Operator, target: Number(r.target), target2: r.target2 === null ? null : Number(r.target2), unit: String(r.unit), notes: String(r.notes), createdAt: Number(r.created_at) };
      const validations = (this.db.prepare('SELECT * FROM aether_projects_validations WHERE requirement_id=? ORDER BY recorded_at DESC').all(req.id) as Record<string, unknown>[]).map((v) => mapValidation(v, req));
      return { ...req, validations, status: rollup(validations) };
    });
    const links = (this.db.prepare('SELECT * FROM aether_projects_links WHERE project_id=? ORDER BY created_at').all(id) as Record<string, unknown>[]).map((r) => ({ id: String(r.id), projectId: id, from: String(r.from_ref), to: String(r.to_ref), note: String(r.note), createdAt: Number(r.created_at) }));
    const changes = (this.db.prepare('SELECT * FROM aether_projects_changes WHERE project_id=? ORDER BY at DESC LIMIT 200').all(id) as Record<string, unknown>[]).map((r) => ({ id: String(r.id), projectId: id, itemId: (r.item_id as string) ?? null, summary: String(r.summary), impacted: JSON.parse(String(r.impacted)) as string[], at: Number(r.at) }));
    return { project, items, tasks, decisions, requirements, links, changes };
  }

  /** Links two things in the project. Refs are `item:<id>`, `req:<id>`, `decision:<id>`, `task:<id>`. */
  link(profileId: string, projectId: string, from: string, to: string, note = ''): Link {
    this.own(profileId, projectId);
    for (const r of [from, to]) if (!this.refExists(projectId, r)) throw new Error(`Unknown project reference ${r}`);
    if (from === to) throw new Error('Cannot link a thing to itself');
    const dup = this.db.prepare('SELECT * FROM aether_projects_links WHERE project_id=? AND ((from_ref=? AND to_ref=?) OR (from_ref=? AND to_ref=?))').get(projectId, from, to, to, from) as Record<string, unknown> | undefined;
    if (dup) return { id: String(dup.id), projectId, from: String(dup.from_ref), to: String(dup.to_ref), note: String(dup.note), createdAt: Number(dup.created_at) };
    const l: Link = { id: rid(), projectId, from, to, note: note.slice(0, 1000), createdAt: this.now() };
    this.db.prepare('INSERT INTO aether_projects_links VALUES (?,?,?,?,?,?)').run(l.id, projectId, from, to, l.note, l.createdAt);
    this.touch(projectId);
    return l;
  }
  unlink(profileId: string, projectId: string, linkId: string) {
    this.own(profileId, projectId);
    this.db.prepare('DELETE FROM aether_projects_links WHERE id=? AND project_id=?').run(linkId, projectId);
  }

  private refExists(projectId: string, ref: string): boolean {
    const m = ref.match(/^(item|req|decision|task):([\w-]{1,40})$/);
    if (!m) return false;
    const table = { item: 'aether_projects_items', req: 'aether_projects_reqs', decision: 'aether_projects_decisions', task: 'aether_projects_tasks' }[m[1] as 'item'];
    return !!this.db.prepare(`SELECT id FROM ${table} WHERE id=? AND project_id=?`).get(m[2], projectId);
  }

  /**
   * Everything that may be invalidated if `ref` changes: things linked to it
   * (transitively, through links), requirements whose evidence came from it,
   * and decisions that cite it.
   */
  impact(profileId: string, projectId: string, ref: string): string[] {
    this.own(profileId, projectId);
    const links = this.db.prepare('SELECT from_ref, to_ref FROM aether_projects_links WHERE project_id=?').all(projectId) as { from_ref: string; to_ref: string }[];
    const seen = new Set<string>([ref]);
    const queue = [ref];
    const push = (r: string) => {
      if (!seen.has(r)) {
        seen.add(r);
        queue.push(r);
      }
    };
    while (queue.length) {
      const cur = queue.shift()!;
      for (const l of links) {
        if (l.from_ref === cur) push(l.to_ref);
        if (l.to_ref === cur) push(l.from_ref);
      }
      if (cur.startsWith('item:')) {
        const id = cur.slice(5);
        for (const v of this.db.prepare('SELECT requirement_id FROM aether_projects_validations WHERE source_item_id=? AND requirement_id IN (SELECT id FROM aether_projects_reqs WHERE project_id=?)').all(id, projectId) as { requirement_id: string }[]) push(`req:${v.requirement_id}`);
        for (const d of this.db.prepare('SELECT id, item_ids FROM aether_projects_decisions WHERE project_id=?').all(projectId) as { id: string; item_ids: string }[]) if ((JSON.parse(d.item_ids) as string[]).includes(id)) push(`decision:${d.id}`);
      }
    }
    seen.delete(ref);
    return [...seen];
  }

  /**
   * Records that something changed (e.g. "MCU changed from STM32F103 to STM32G431"),
   * marks evidence that came from the changed item (or from items linked to it) as stale,
   * and returns what needs review. Nothing is deleted.
   */
  recordChange(profileId: string, projectId: string, input: { ref?: string | null; summary: string }): Change {
    this.own(profileId, projectId);
    if (input.ref && !this.refExists(projectId, input.ref)) throw new Error('Unknown project reference');
    const impacted = input.ref ? this.impact(profileId, projectId, input.ref) : [];
    const items = [input.ref, ...impacted].filter((r): r is string => !!r && r.startsWith('item:')).map((r) => r.slice(5));
    const reason = input.summary.slice(0, 300);
    for (const id of items) this.db.prepare('UPDATE aether_projects_validations SET stale_reason=? WHERE source_item_id=? AND stale_reason IS NULL AND requirement_id IN (SELECT id FROM aether_projects_reqs WHERE project_id=?)').run(reason, id, projectId);
    const c: Change = { id: rid(), projectId, itemId: input.ref?.startsWith('item:') ? input.ref.slice(5) : null, summary: input.summary.slice(0, 2000), impacted, at: this.now() };
    this.db.prepare('INSERT INTO aether_projects_changes VALUES (?,?,?,?,?,?)').run(c.id, projectId, c.itemId, c.summary, JSON.stringify(impacted), c.at);
    this.touch(projectId);
    return c;
  }

  /** Clears the stale flag after the user re-checked the evidence. */
  confirmValidation(profileId: string, projectId: string, id: string) {
    this.own(profileId, projectId);
    this.db.prepare('UPDATE aether_projects_validations SET stale_reason=NULL WHERE id=? AND requirement_id IN (SELECT id FROM aether_projects_reqs WHERE project_id=?)').run(id, projectId);
  }

  /** Raises or lowers how far a piece of evidence has got (e.g. simulated → measured after a bench test). */
  setEvidence(profileId: string, projectId: string, id: string, evidence: Evidence) {
    this.own(profileId, projectId);
    if (!isEvidence(evidence)) throw new Error('Invalid evidence level');
    this.db.prepare('UPDATE aether_projects_validations SET evidence=?, verified=? WHERE id=? AND requirement_id IN (SELECT id FROM aether_projects_reqs WHERE project_id=?)').run(evidence, evidence === 'verified' ? 1 : 0, id, projectId);
  }

  /** Searches every artefact of every project in the profile. */
  search(profileId: string, query: string): { projectId: string; projectName: string; kind: string; id: string; title: string; snippet: string }[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: { projectId: string; projectName: string; kind: string; id: string; title: string; snippet: string }[] = [];
    const hit = (s: string) => s.toLowerCase().includes(q);
    for (const p of this.list(profileId)) {
      const d = this.get(profileId, p.id);
      if (hit(`${p.name} ${p.description}`)) out.push({ projectId: p.id, projectName: p.name, kind: 'project', id: p.id, title: p.name, snippet: p.description.slice(0, 160) });
      for (const i of d.items) if (hit(`${i.title} ${i.ref}`)) out.push({ projectId: p.id, projectName: p.name, kind: i.kind, id: i.id, title: i.title, snippet: i.ref.slice(0, 160) });
      for (const r of d.requirements) if (hit(`${r.name} ${r.parameter} ${r.notes}`)) out.push({ projectId: p.id, projectName: p.name, kind: 'requirement', id: r.id, title: r.name, snippet: `${r.parameter} ${r.operator} ${r.target} ${r.unit}` });
      for (const x of d.decisions) if (hit(`${x.title} ${x.rationale} ${x.alternatives}`)) out.push({ projectId: p.id, projectName: p.name, kind: 'decision', id: x.id, title: x.title, snippet: x.rationale.slice(0, 160) });
      for (const t of d.tasks) if (hit(t.title)) out.push({ projectId: p.id, projectName: p.name, kind: 'task', id: t.id, title: t.title, snippet: t.status });
      if (out.length > 200) break;
    }
    return out.slice(0, 200);
  }

  /** Complete, self-describing project archive (JSON) for hand-over or backup. */
  exportProject(profileId: string, id: string) {
    return { format: 'aether-project/1', exportedAt: new Date(this.now()).toISOString(), ...this.get(profileId, id) };
  }

  /** Imports an archive made by exportProject as a new project (ids are regenerated). */
  importProject(profileId: string, data: unknown): Project {
    const d = data as ReturnType<ProjectStore['exportProject']>;
    if (!d || d.format !== 'aether-project/1' || !d.project) throw new Error('Not an AETHER project archive');
    const p = this.create(profileId, { name: String(d.project.name), description: String(d.project.description ?? ''), color: String(d.project.color ?? '#8b7dff') });
    const map = new Map<string, string>();
    for (const i of (d.items ?? []).slice(0, 5000)) map.set(`item:${i.id}`, `item:${this.addItem(profileId, p.id, { kind: i.kind, title: String(i.title), ref: String(i.ref), app: i.app ?? null, meta: i.meta ?? {} }).id}`);
    for (const t of (d.tasks ?? []).slice(0, 5000)) {
      const nt = this.addTask(profileId, p.id, String(t.title), t.due);
      if (t.status !== 'todo') this.setTask(profileId, p.id, nt.id, { status: t.status });
      map.set(`task:${t.id}`, `task:${nt.id}`);
    }
    for (const x of (d.decisions ?? []).slice(0, 5000)) map.set(`decision:${x.id}`, `decision:${this.addDecision(profileId, p.id, { title: String(x.title), rationale: String(x.rationale), alternatives: String(x.alternatives ?? ''), itemIds: (x.itemIds ?? []).map((i) => map.get(`item:${i}`)?.slice(5)).filter((i): i is string => !!i) }).id}`);
    for (const r of (d.requirements ?? []).slice(0, 5000)) {
      const nr = this.addRequirement(profileId, p.id, { name: String(r.name), parameter: String(r.parameter), operator: r.operator, target: Number(r.target), target2: r.target2, unit: String(r.unit), notes: String(r.notes ?? '') });
      map.set(`req:${r.id}`, `req:${nr.id}`);
      for (const v of r.validations ?? []) this.addValidation(profileId, p.id, nr.id, { value: v.value, unit: String(v.unit), source: v.source, sourceRef: String(v.sourceRef ?? ''), sourceItemId: v.sourceItemId ? map.get(`item:${v.sourceItemId}`)?.slice(5) ?? null : null, evidence: v.evidence, note: v.note });
    }
    for (const l of d.links ?? []) {
      const a = map.get(l.from);
      const b = map.get(l.to);
      if (a && b) this.link(profileId, p.id, a, b, l.note);
    }
    return p;
  }

  addItem(profileId: string, projectId: string, input: Omit<ProjectItem, 'id' | 'projectId' | 'addedAt' | 'meta'> & { meta?: Record<string, unknown> }): ProjectItem {
    this.own(profileId, projectId);
    const dup = this.db.prepare('SELECT * FROM aether_projects_items WHERE project_id=? AND kind=? AND ref=?').get(projectId, input.kind, input.ref) as Record<string, unknown> | undefined;
    if (dup) return mapItem(dup);
    const it: ProjectItem = { id: rid(), projectId, kind: input.kind, title: input.title.slice(0, 500), ref: input.ref.slice(0, 4000), app: input.app ?? null, meta: input.meta ?? {}, addedAt: this.now() };
    this.db.prepare('INSERT INTO aether_projects_items VALUES (?,?,?,?,?,?,?,?)').run(it.id, projectId, it.kind, it.title, it.ref, it.app, JSON.stringify(it.meta).slice(0, 100_000), it.addedAt);
    this.touch(projectId);
    return it;
  }

  removeItem(profileId: string, projectId: string, itemId: string) {
    this.own(profileId, projectId);
    this.db.prepare('DELETE FROM aether_projects_items WHERE id=? AND project_id=?').run(itemId, projectId);
  }

  addTask(profileId: string, projectId: string, title: string, due?: string | null): Task {
    this.own(profileId, projectId);
    const t: Task = { id: rid(), projectId, title: title.slice(0, 500), status: 'todo', due: due ?? null, createdAt: this.now() };
    this.db.prepare('INSERT INTO aether_projects_tasks VALUES (?,?,?,?,?,?)').run(t.id, projectId, t.title, t.status, t.due, t.createdAt);
    this.touch(projectId);
    return t;
  }
  setTask(profileId: string, projectId: string, taskId: string, patch: { status?: Task['status']; title?: string }) {
    this.own(profileId, projectId);
    if (patch.status) this.db.prepare('UPDATE aether_projects_tasks SET status=? WHERE id=? AND project_id=?').run(patch.status, taskId, projectId);
    if (patch.title) this.db.prepare('UPDATE aether_projects_tasks SET title=? WHERE id=? AND project_id=?').run(patch.title.slice(0, 500), taskId, projectId);
  }
  deleteTask(profileId: string, projectId: string, taskId: string) {
    this.own(profileId, projectId);
    this.db.prepare('DELETE FROM aether_projects_tasks WHERE id=? AND project_id=?').run(taskId, projectId);
  }

  addDecision(profileId: string, projectId: string, d: { title: string; rationale: string; alternatives?: string; itemIds?: string[] }): Decision {
    this.own(profileId, projectId);
    const dec: Decision = { id: rid(), projectId, title: d.title.slice(0, 500), rationale: d.rationale.slice(0, 20000), alternatives: (d.alternatives ?? '').slice(0, 20000), itemIds: (d.itemIds ?? []).slice(0, 50), decidedAt: this.now() };
    this.db.prepare('INSERT INTO aether_projects_decisions VALUES (?,?,?,?,?,?,?)').run(dec.id, projectId, dec.title, dec.rationale, dec.alternatives, JSON.stringify(dec.itemIds), dec.decidedAt);
    this.touch(projectId);
    return dec;
  }
  deleteDecision(profileId: string, projectId: string, id: string) {
    this.own(profileId, projectId);
    this.db.prepare('DELETE FROM aether_projects_decisions WHERE id=? AND project_id=?').run(id, projectId);
  }

  addRequirement(profileId: string, projectId: string, r: Omit<Requirement, 'id' | 'projectId' | 'createdAt'>): Requirement {
    this.own(profileId, projectId);
    const req: Requirement = { ...r, id: rid(), projectId, name: r.name.slice(0, 300), parameter: r.parameter.slice(0, 200), unit: r.unit.slice(0, 20), notes: (r.notes ?? '').slice(0, 5000), createdAt: this.now() };
    this.db.prepare('INSERT INTO aether_projects_reqs VALUES (?,?,?,?,?,?,?,?,?,?)').run(req.id, projectId, req.name, req.parameter, req.operator, req.target, req.target2, req.unit, req.notes, req.createdAt);
    this.touch(projectId);
    return req;
  }
  deleteRequirement(profileId: string, projectId: string, id: string) {
    this.own(profileId, projectId);
    this.db.prepare('DELETE FROM aether_projects_validations WHERE requirement_id=?').run(id);
    this.db.prepare('DELETE FROM aether_projects_reqs WHERE id=? AND project_id=?').run(id, projectId);
  }

  /** Records evidence (e.g. a datasheet value from the Electronics & ECE module or a simulation result) and returns its computed status. */
  addValidation(profileId: string, projectId: string, requirementId: string, v: Pick<Validation, 'value' | 'unit' | 'source' | 'sourceRef'> & { sourceItemId?: string | null; verified?: boolean; evidence?: Evidence; note?: string }): Validation {
    this.own(profileId, projectId);
    const r = this.db.prepare('SELECT * FROM aether_projects_reqs WHERE id=? AND project_id=?').get(requirementId, projectId) as Record<string, unknown> | undefined;
    if (!r) throw new Error('Requirement not found');
    const defaultEvidence: Evidence = v.verified ? 'verified' : v.source === 'measurement' ? 'measured' : v.source === 'simulation' ? 'simulated' : v.source === 'calculation' ? 'calculated' : 'proposed';
    const evidence = isEvidence(v.evidence) ? v.evidence : defaultEvidence;
    if (v.sourceItemId && !this.db.prepare('SELECT id FROM aether_projects_items WHERE id=? AND project_id=?').get(v.sourceItemId, projectId)) throw new Error('Source item is not in this project');
    const row = { id: rid(), requirement_id: requirementId, value: v.value, unit: v.unit.slice(0, 20), source: v.source, source_ref: v.sourceRef.slice(0, 2000), source_item_id: v.sourceItemId ?? null, verified: evidence === 'verified' ? 1 : 0, note: (v.note ?? '').slice(0, 5000), recorded_at: this.now(), evidence, stale_reason: null };
    this.db.prepare('INSERT INTO aether_projects_validations (id, requirement_id, value, unit, source, source_ref, source_item_id, verified, note, recorded_at, evidence, stale_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(row.id, row.requirement_id, row.value, row.unit, row.source, row.source_ref, row.source_item_id, row.verified, row.note, row.recorded_at, row.evidence, null);
    this.touch(projectId);
    return mapValidation(row, { operator: r.operator as Operator, target: Number(r.target), target2: r.target2 === null ? null : Number(r.target2), unit: String(r.unit) });
  }
  deleteValidation(profileId: string, projectId: string, id: string) {
    this.own(profileId, projectId);
    this.db.prepare('DELETE FROM aether_projects_validations WHERE id=? AND requirement_id IN (SELECT id FROM aether_projects_reqs WHERE project_id=?)').run(id, projectId);
  }
}

function mapProject(r: Record<string, unknown>): Project {
  return { id: String(r.id), name: String(r.name), description: String(r.description), color: String(r.color), workspaceId: (r.workspace_id as string) ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}
function mapItem(r: Record<string, unknown>): ProjectItem {
  return { id: String(r.id), projectId: String(r.project_id), kind: r.kind as ItemKind, title: String(r.title), ref: String(r.ref), app: (r.app as string) ?? null, meta: JSON.parse(String(r.meta || '{}')), addedAt: Number(r.added_at) };
}
function mapValidation(v: Record<string, unknown>, req: Pick<Requirement, 'operator' | 'target' | 'target2' | 'unit'>): Validation {
  const value = v.value === null || v.value === undefined ? null : Number(v.value);
  return { id: String(v.id), requirementId: String(v.requirement_id), value, unit: String(v.unit), source: v.source as Validation['source'], sourceRef: String(v.source_ref), sourceItemId: (v.source_item_id as string) ?? null, verified: Boolean(Number(v.verified)), evidence: isEvidence(v.evidence) ? v.evidence : Number(v.verified) ? 'verified' : 'proposed', status: evaluate(req, value, String(v.unit)), note: String(v.note), recordedAt: Number(v.recorded_at), stale: v.stale_reason !== null && v.stale_reason !== undefined, staleReason: (v.stale_reason as string) ?? null };
}

/** Project documentation as Markdown (opens in the Writer through createFromMarkdown). */
export function projectReport(data: ReturnType<ProjectStore['get']>): string {
  const { project, items, tasks, decisions, requirements } = data;
  const L: string[] = [`# ${project.name}`, '', project.description || '_No description._', ''];
  L.push('## Requirements and validation', '');
  if (!requirements.length) L.push('_No requirements recorded._', '');
  for (const r of requirements) {
    const tgt = r.operator === 'between' ? `${r.target}–${r.target2} ${r.unit}` : `${r.operator} ${r.target} ${r.unit}`;
    L.push(`### ${r.name} — ${r.status.toUpperCase()}`, '', `${r.parameter} ${tgt}${r.notes ? `. ${r.notes}` : ''}`, '');
    for (const v of r.validations) L.push(`- ${v.status}: ${v.value ?? '?'} ${v.unit} from ${v.source} (${v.sourceRef || 'no reference'}), ${v.evidence}${v.stale ? ` — STALE: ${v.staleReason}` : ''}${v.note ? ` — ${v.note}` : ''}`);
    if (!r.validations.length) L.push('- No evidence yet (unknown).');
    L.push('');
  }
  L.push('## Decisions', '');
  for (const d of decisions) L.push(`### ${d.title}`, '', d.rationale, ...(d.alternatives ? ['', `Alternatives considered: ${d.alternatives}`] : []), '');
  if (!decisions.length) L.push('_None recorded._', '');
  L.push('## Tasks', '', ...tasks.map((t) => `- ${t.status === 'done' ? '[x]' : '[ ]'} ${t.title}${t.due ? ` (due ${t.due})` : ''}`), '');
  L.push('## Materials', '', ...items.map((i) => `- ${i.kind}: ${i.title}${/^https?:/.test(i.ref) ? ` — ${i.ref}` : ''}`), '');
  if (data.changes.length) L.push('## Change log', '', ...data.changes.map((c) => `- ${new Date(c.at).toISOString().slice(0, 10)}: ${c.summary}${c.impacted.length ? ` (${c.impacted.length} linked item${c.impacted.length === 1 ? '' : 's'} to review)` : ''}`), '');
  L.push('---', '', '_Evidence levels: proposed, calculated and simulated results are not proof. A requirement is marked satisfied only by current measured, reviewed or verified evidence._');
  return L.join('\n');
}
