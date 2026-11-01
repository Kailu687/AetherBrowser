import { beforeEach, describe, expect, it } from 'vitest';
import { AetherStore } from '../src/index';

let store: AetherStore;
beforeEach(() => {
  store = AetherStore.open(':memory:');
});

describe('profiles', () => {
  it('creates, updates and deletes with cascading data', () => {
    const p = store.createProfile({ name: 'VIT Chennai' });
    expect(p.closeBehavior).toBe('ask');
    store.updateProfile(p.id, { name: 'VIT', closeBehavior: 'save', searchEngine: 'duckduckgo' });
    expect(store.getProfile(p.id)).toMatchObject({ name: 'VIT', closeBehavior: 'save', searchEngine: 'duckduckgo' });

    store.recordVisit(p.id, 'https://example.com/', 'Example');
    store.addBookmark(p.id, { title: 'Ex', url: 'https://example.com/' });
    store.createWorkspace(p.id, { name: 'Radar' });
    expect(store.profileDataSummary(p.id)).toMatchObject({ history: 1, bookmarks: 1, workspaces: 1 });

    store.deleteProfile(p.id);
    expect(store.getProfile(p.id)).toBeNull();
    expect(store.listHistory(p.id)).toHaveLength(0);
    expect(store.listWorkspaces(p.id)).toHaveLength(0);
  });
});

describe('history', () => {
  it('keeps profiles separate and counts visits', () => {
    const a = store.createProfile({ name: 'A' });
    const b = store.createProfile({ name: 'B' });
    store.recordVisit(a.id, 'https://ieee.org/', 'IEEE', 'typed');
    store.recordVisit(a.id, 'https://ieee.org/', '');
    store.recordVisit(b.id, 'https://youtube.com/', 'YouTube');
    const ha = store.listHistory(a.id);
    expect(ha).toHaveLength(1);
    expect(ha[0]).toMatchObject({ visitCount: 2, typedCount: 1, title: 'IEEE' });
    expect(store.listHistory(b.id).map((e) => e.url)).toEqual(['https://youtube.com/']);
  });

  it('skips internal and non-web URLs', () => {
    const a = store.createProfile({ name: 'A' });
    store.recordVisit(a.id, 'aether://newtab', 'New tab');
    store.recordVisit(a.id, 'file:///C:/secret.txt', 'x');
    expect(store.listHistory(a.id)).toHaveLength(0);
  });

  it('suggests prefix matches first and escapes LIKE wildcards', () => {
    const a = store.createProfile({ name: 'A' });
    store.recordVisit(a.id, 'https://www.ti.com/product/LM741', 'LM741 Op Amp');
    store.recordVisit(a.id, 'https://example.com/ti', 'Other');
    expect(store.suggest(a.id, 'ti.com')[0].url).toContain('ti.com/product');
    expect(store.suggest(a.id, '%')).toHaveLength(0);
  });

  it('clears recent history only', () => {
    const a = store.createProfile({ name: 'A' });
    store.recordVisit(a.id, 'https://old.example/', 'old');
    const cut = Date.now() + 1;
    store.clearHistory(a.id, cut);
    expect(store.listHistory(a.id)).toHaveLength(1);
    store.clearHistory(a.id);
    expect(store.listHistory(a.id)).toHaveLength(0);
  });
});

describe('bookmarks', () => {
  it('supports folders scoped to the profile', () => {
    const a = store.createProfile({ name: 'A' });
    const b = store.createProfile({ name: 'B' });
    const folder = store.addBookmark(a.id, { title: 'Datasheets', url: null });
    store.addBookmark(a.id, { title: 'LM741', url: 'https://ti.com/lm741', parentId: folder.id });
    expect(store.listBookmarks(a.id, folder.id)).toHaveLength(1);
    expect(() => store.addBookmark(b.id, { title: 'x', url: 'https://x.y', parentId: folder.id })).toThrow();
    store.deleteBookmark(a.id, folder.id);
    expect(store.allBookmarks(a.id)).toHaveLength(0);
  });
});

describe('workspaces and window sessions', () => {
  it('round-trips tabs, scroll positions and split state', () => {
    const p = store.createProfile({ name: 'Startup' });
    const ws = store.createWorkspace(p.id, { name: 'Aircraft Design' });
    store.updateWorkspace(ws.id, { tabs: [{ url: 'https://a.example/', title: 'A', scrollY: 1200 }], notes: 'idea: canard' });
    expect(store.getWorkspace(ws.id)).toMatchObject({ notes: 'idea: canard', tabs: [{ scrollY: 1200 }] });

    store.saveWindowSession({
      id: 'w1', profileId: p.id, workspaceId: ws.id, state: 'open', title: 'A', bounds: { x: 1, y: 2, width: 800, height: 600 },
      maximized: false, tabs: [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: 'B' }], activeIndex: 1,
      split: { left: 0, right: 1, ratio: 0.5 },
    });
    store.saveWindowSession({ ...store.getWindowSession('w1')!, state: 'saved' });
    const s = store.listWindowSessions(p.id, 'saved');
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ activeIndex: 1, split: { ratio: 0.5 }, bounds: { width: 800 } });
    store.deleteWorkspace(ws.id);
    expect(store.getWindowSession('w1')!.workspaceId).toBeNull();
  });
});

describe('module storage', () => {
  it('runs module migrations once and scopes kv', () => {
    const m = store.moduleStorage('focus');
    const migrations = [{ version: 1, up: 'CREATE TABLE focus_rules (id INTEGER PRIMARY KEY, pattern TEXT)' }];
    m.migrate(migrations);
    m.migrate(migrations);
    m.db.prepare('INSERT INTO focus_rules (pattern) VALUES (?)').run('youtube.com');
    m.kv.set('enabled', true, 'p1');
    expect(m.kv.get('enabled', 'p1')).toBe(true);
    expect(m.kv.get('enabled')).toBeUndefined();
    expect(store.moduleStorage('other').kv.get('enabled', 'p1')).toBeUndefined();
  });
});

describe('downloads', () => {
  it('marks stale downloads interrupted', () => {
    const p = store.createProfile({ name: 'A' });
    const id = store.addDownload(p.id, { url: 'https://x/y.pdf', filename: 'y.pdf', path: '/tmp/y.pdf', mime: 'application/pdf', totalBytes: 10 });
    store.markStaleDownloadsInterrupted();
    expect(store.getDownload(id)!.state).toBe('interrupted');
  });
});
