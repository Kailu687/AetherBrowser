import type { AetherMainModule, MainHost, SqlDatabase } from '@aether/plugin-api';
import { DOC_TEMPLATES, getDocTemplate } from './templates.js';
import { WRITER_MIGRATIONS, WriterStore } from './store.js';
import type { PMNode } from './doc.js';
import { markdownToDoc } from './markdown-import.js';

export const WRITER_MODULE_ID = 'aether.writer';

const STYLES = ['apa', 'ieee', 'mla', 'chicago'] as const;
const obj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {});
const str = (p: Record<string, unknown>, k: string, max = 200): string => {
  const v = p[k];
  if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${k}`);
  return v;
};
const optStr = (p: Record<string, unknown>, k: string, max = 200) => (p[k] === undefined ? undefined : str(p, k, max));

function validDoc(v: unknown): PMNode {
  const json = JSON.stringify(v);
  if (json.length > 40_000_000) throw new Error('Document too large');
  const d = v as PMNode;
  if (!d || d.type !== 'doc') throw new Error('Invalid document');
  return d;
}

/** Writer documents: storage, versions and PDF rendering. Editing happens in the UI. */
export function createWriterModule(): AetherMainModule {
  let host: MainHost;
  let mem: WriterStore | null = null;
  return {
    id: WRITER_MODULE_ID,
    async activate(h) {
      host = h;
      h.storage.migrate(WRITER_MIGRATIONS);
      const disk = new WriterStore(h.storage.db);
      const memStore = async () => {
        if (mem) return mem;
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(':memory:') as unknown as SqlDatabase;
        for (const m of WRITER_MIGRATIONS) db.exec(m.up);
        mem = new WriterStore(db);
        return mem;
      };
      const store = async (ctx: { isPrivate: boolean }) => (ctx.isPrivate ? memStore() : disk);
      const handle = (name: string, fn: (p: Record<string, unknown>, s: WriterStore, ctx: { profileId: string; isPrivate: boolean }) => unknown) =>
        host.ipc.handle(name, async (payload, ctx) => fn(obj(payload), await store(ctx), ctx));

      handle('templates', () => DOC_TEMPLATES.map(({ build: _b, ...t }) => t));
      handle('list', (_p, s, c) => s.list(c.profileId));
      handle('get', (p, s, c) => s.get(c.profileId, str(p, 'id')));
      handle('create', (p, s, c) => {
        const t = getDocTemplate(optStr(p, 'template') ?? 'blank');
        const title = optStr(p, 'title', 300) || (t.id === 'blank' ? 'Untitled document' : t.name);
        const content = p.content ? validDoc(p.content) : t.build(title);
        return s.create(c.profileId, { title, template: t.id, kind: t.kind, style: t.style, font: t.font, content });
      });
      handle('update', (p, s, c) => {
        const patch = obj(p.patch);
        const style = patch.style as string | undefined;
        if (style !== undefined && !STYLES.includes(style as never)) throw new Error('Invalid style');
        return s.update(c.profileId, str(p, 'id'), {
          ...(patch.title !== undefined ? { title: str(patch, 'title', 300) } : {}),
          ...(style ? { style: style as never } : {}),
          ...(patch.font !== undefined ? { font: str(patch, 'font', 80) } : {}),
          ...(patch.kind !== undefined ? { kind: str(patch, 'kind', 20) } : {}),
          ...(patch.content !== undefined ? { content: validDoc(patch.content) } : {}),
        });
      });
      /** Used by Labs (e.g. Research Lab's review outline): Markdown in, new document out. */
      handle('createFromMarkdown', (p, s, c) => {
        const t = getDocTemplate(optStr(p, 'template') ?? 'blank');
        const title = optStr(p, 'title', 300) || 'Imported document';
        const markdown = str(p, 'markdown', 5_000_000);
        return s.create(c.profileId, { title, template: t.id, kind: t.kind, style: t.style, font: t.font, content: markdownToDoc(markdown, title) });
      });
      handle('delete', (p, s, c) => s.delete(c.profileId, str(p, 'id')));
      handle('duplicate', (p, s, c) => {
        const d = s.get(c.profileId, str(p, 'id'));
        if (!d) return null;
        return s.create(c.profileId, { ...d, title: `${d.title} (copy)` });
      });
      handle('snapshot', (p, s, c) => s.snapshot(c.profileId, str(p, 'id'), optStr(p, 'label', 120) || 'Manual save'));
      handle('versions', (p, s, c) => s.versions(c.profileId, str(p, 'id')));
      handle('restore', (p, s, c) => s.restore(c.profileId, str(p, 'id'), Number(p.versionId)));
      handle('pdf', async (p) => {
        if (!host.printToPdf) throw new Error('PDF export is not available in this build');
        const html = str(p, 'html', 60_000_000);
        const bytes = await host.printToPdf(html, { pageSize: p.pageSize === 'Letter' ? 'Letter' : 'A4' });
        return bytes;
      });
      /** "Clip from page": the active tab's selection (or first paragraph) plus its title and URL. */
      host.ipc.handle('clip', async (_p, ctx) => {
        const tab = host.tabs.getActive(ctx.windowId);
        if (!tab) return null;
        const page = await host.tabs.getPageContent(tab.tabId);
        if (!page) return null;
        const text = (page.selection || '').trim();
        return { url: page.url, title: page.title, selection: text.slice(0, 20000) };
      });
      h.events.on('profileDeleted', ({ profileId }) => disk.deleteProfile(profileId));
    },
  };
}
