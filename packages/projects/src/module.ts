import type { AetherMainModule, MainHost, SqlDatabase } from '@aether/plugin-api';
import { EVIDENCE_LEVELS, PROJECT_MIGRATIONS, ProjectStore, projectReport, type Evidence, type ItemKind, type Operator } from './model.js';

export const PROJECTS_MODULE_ID = 'aether.projects';
const KINDS: ItemKind[] = ['tab', 'source', 'document', 'code', 'schematic', 'dataset', 'note', 'file', 'result', 'link'];
const OPS: Operator[] = ['<=', '>=', '<', '>', '=', 'between'];
const SOURCES = ['datasheet', 'simulation', 'measurement', 'calculation', 'other'] as const;

const obj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {});
const s = (p: Record<string, unknown>, k: string, max = 500, optional = false): string => {
  const v = p[k];
  if (v === undefined && optional) return '';
  if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${k}`);
  return v;
};
const n = (p: Record<string, unknown>, k: string, nullable = false): number | null => {
  const v = p[k];
  if ((v === null || v === undefined || v === '') && nullable) return null;
  const x = Number(v);
  if (!Number.isFinite(x)) throw new Error(`Invalid ${k}`);
  return x;
};
function oneOf<T extends string>(p: Record<string, unknown>, k: string, list: readonly T[]): T {
  if (!list.includes(p[k] as T)) throw new Error(`Invalid ${k}`);
  return p[k] as T;
}

/** Projects (Core): ties tabs, sources, documents, module artefacts, tasks, decisions and requirement checks together. */
export function createProjectsModule(): AetherMainModule {
  return {
    id: PROJECTS_MODULE_ID,
    async activate(host: MainHost) {
      host.storage.migrate(PROJECT_MIGRATIONS);
      const disk = new ProjectStore(host.storage.db);
      let mem: ProjectStore | null = null;
      const store = async (isPrivate: boolean) => {
        if (!isPrivate) return disk;
        if (!mem) {
          const { DatabaseSync } = await import('node:sqlite');
          const db = new DatabaseSync(':memory:') as unknown as SqlDatabase;
          for (const m of PROJECT_MIGRATIONS) db.exec(m.up);
          mem = new ProjectStore(db);
        }
        return mem;
      };
      const h = (name: string, fn: (p: Record<string, unknown>, st: ProjectStore, ctx: { profileId: string; windowId: number }) => unknown) =>
        host.ipc.handle(name, async (payload, ctx) => {
          const r = await fn(obj(payload), await store(ctx.isPrivate), ctx);
          if (!['list', 'get', 'report', 'impact', 'search', 'export'].includes(name)) host.ipc.emit('changed', {});
          return r;
        });
      const pid = (p: Record<string, unknown>) => s(p, 'projectId', 64);

      h('list', (_p, st, c) => st.list(c.profileId));
      h('get', (p, st, c) => st.get(c.profileId, s(p, 'id', 64)));
      h('create', (p, st, c) => st.create(c.profileId, { name: s(p, 'name', 200), description: s(p, 'description', 5000, true), color: s(p, 'color', 20, true) || undefined }));
      h('update', (p, st, c) => st.update(c.profileId, s(p, 'id', 64), { ...(p.name !== undefined ? { name: s(p, 'name', 200) } : {}), ...(p.description !== undefined ? { description: s(p, 'description', 5000) } : {}), ...(p.color !== undefined ? { color: s(p, 'color', 20) } : {}) }));
      h('delete', (p, st, c) => st.delete(c.profileId, s(p, 'id', 64)));
      h('addItem', (p, st, c) => st.addItem(c.profileId, pid(p), { kind: oneOf(p, 'kind', KINDS), title: s(p, 'title', 500), ref: s(p, 'ref', 4000), app: s(p, 'app', 100, true) || null, meta: obj(p.meta) }));
      h('removeItem', (p, st, c) => st.removeItem(c.profileId, pid(p), s(p, 'itemId', 64)));
      /** "Add this tab to a project": stores the URL and title only (no page content, no cookies). */
      h('addActiveTab', (p, st, c) => {
        const tab = host.tabs.getActive(c.windowId);
        if (!tab || !/^(https?|file):/.test(tab.url)) throw new Error('Open a web page first.');
        return st.addItem(c.profileId, pid(p), { kind: 'tab', title: tab.title || tab.url, ref: tab.url, app: null });
      });
      h('openItem', (p, _st, c) => {
        const ref = s(p, 'ref', 4000);
        if (/^(https?|file):/.test(ref)) host.tabs.open(c.windowId, ref);
        return true;
      });
      h('addTask', (p, st, c) => st.addTask(c.profileId, pid(p), s(p, 'title', 500), s(p, 'due', 20, true) || null));
      h('setTask', (p, st, c) => st.setTask(c.profileId, pid(p), s(p, 'taskId', 64), { ...(p.status ? { status: oneOf(p, 'status', ['todo', 'doing', 'done'] as const) } : {}), ...(p.title ? { title: s(p, 'title', 500) } : {}) }));
      h('deleteTask', (p, st, c) => st.deleteTask(c.profileId, pid(p), s(p, 'taskId', 64)));
      h('addDecision', (p, st, c) => st.addDecision(c.profileId, pid(p), { title: s(p, 'title', 500), rationale: s(p, 'rationale', 20000), alternatives: s(p, 'alternatives', 20000, true), itemIds: Array.isArray(p.itemIds) ? p.itemIds.filter((x): x is string => typeof x === 'string') : [] }));
      h('deleteDecision', (p, st, c) => st.deleteDecision(c.profileId, pid(p), s(p, 'id', 64)));
      h('addRequirement', (p, st, c) =>
        st.addRequirement(c.profileId, pid(p), { name: s(p, 'name', 300), parameter: s(p, 'parameter', 200), operator: oneOf(p, 'operator', OPS), target: n(p, 'target')!, target2: n(p, 'target2', true), unit: s(p, 'unit', 20, true), notes: s(p, 'notes', 5000, true) }),
      );
      h('deleteRequirement', (p, st, c) => st.deleteRequirement(c.profileId, pid(p), s(p, 'id', 64)));
      /**
       * Evidence from Modules or the user: {projectId, requirementId, value, unit, source, sourceRef, evidence?, sourceItemId?, note}.
       * New evidence is at most "measured"; "reviewed" and "verified" are set only by the user through setEvidence in Projects.
       */
      const RECORDABLE: Evidence[] = ['proposed', 'calculated', 'simulated', 'measured'];
      h('addValidation', (p, st, c) =>
        st.addValidation(c.profileId, pid(p), s(p, 'requirementId', 64), {
          value: n(p, 'value', true),
          unit: s(p, 'unit', 20, true),
          source: oneOf(p, 'source', SOURCES),
          sourceRef: s(p, 'sourceRef', 2000, true),
          sourceItemId: s(p, 'sourceItemId', 64, true) || null,
          evidence: p.evidence === undefined ? undefined : oneOf(p, 'evidence', RECORDABLE),
          note: s(p, 'note', 5000, true),
        }),
      );
      h('setEvidence', (p, st, c) => st.setEvidence(c.profileId, pid(p), s(p, 'id', 64), oneOf(p, 'evidence', EVIDENCE_LEVELS)));
      h('confirmValidation', (p, st, c) => st.confirmValidation(c.profileId, pid(p), s(p, 'id', 64)));
      const REF = /^(item|req|decision|task):[\w-]{1,40}$/;
      const ref = (p: Record<string, unknown>, k: string) => {
        const v = s(p, k, 60);
        if (!REF.test(v)) throw new Error(`Invalid ${k}`);
        return v;
      };
      h('link', (p, st, c) => st.link(c.profileId, pid(p), ref(p, 'from'), ref(p, 'to'), s(p, 'note', 1000, true)));
      h('unlink', (p, st, c) => st.unlink(c.profileId, pid(p), s(p, 'id', 64)));
      h('impact', (p, st, c) => st.impact(c.profileId, pid(p), ref(p, 'ref')));
      h('recordChange', (p, st, c) => st.recordChange(c.profileId, pid(p), { ref: p.ref ? ref(p, 'ref') : null, summary: s(p, 'summary', 2000) }));
      h('search', (p, st, c) => st.search(c.profileId, s(p, 'query', 200)));
      h('export', (p, st, c) => st.exportProject(c.profileId, s(p, 'id', 64)));
      h('import', (p, st, c) => {
        const text = s(p, 'json', 20_000_000);
        return st.importProject(c.profileId, JSON.parse(text));
      });
      h('deleteValidation', (p, st, c) => st.deleteValidation(c.profileId, pid(p), s(p, 'id', 64)));
      h('report', (p, st, c) => projectReport(st.get(c.profileId, s(p, 'id', 64))));
      host.events.on('profileDeleted', ({ profileId }) => disk.deleteProfile(profileId));
    },
  };
}
