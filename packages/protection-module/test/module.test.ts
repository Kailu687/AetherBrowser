import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MainHost, NavigationInterceptor, SessionContext, ShellEvents, TabContext } from '@aether/plugin-api';
import type { ElectronRequestDetails, SessionLike } from '@aether/web-request-hub';
import { createProtectionModule } from '../src/index.js';

const LIST = '||tracker.example^$third-party\n';
type Ctx = { windowId: number; profileId: string; isPrivate: boolean };

function fakeHost(shared?: { db: DatabaseSync; dataDir: string; kv: Map<string, unknown> }) {
  const db = shared?.db ?? new DatabaseSync(':memory:');
  const dataDir = shared?.dataDir ?? mkdtempSync(join(tmpdir(), 'aether-prot-'));
  const kvMap = shared?.kv ?? new Map<string, unknown>();
  const sessionListeners: ((s: any, c: SessionContext) => void)[] = [];
  const pages: Record<string, (u: URL, c: SessionContext) => any> = {};
  const events: Record<string, ((p: any) => void)[]> = {};
  const ipc: Record<string, (p: unknown, c: Ctx) => any> = {};
  const interceptors: NavigationInterceptor[] = [];
  const navigations: [number, string][] = [];
  const emitted: [string, unknown][] = [];
  const tabs = new Map<number, TabContext>();
  const wcTabs = new Map<number, number>();
  const fetchCalls: string[] = [];
  const host: MainHost = {
    moduleId: 'aether.protection',
    dataDir,
    storage: {
      db: db as any,
      migrate: () => {},
      kv: {
        get: (k, p) => structuredClone(kvMap.get(`${p ?? ''}|${k}`)) as any,
        set: (k, v, p) => void kvMap.set(`${p ?? ''}|${k}`, structuredClone(v)),
        delete: (k, p) => void kvMap.delete(`${p ?? ''}|${k}`),
      },
    },
    sessions: { onSessionCreated: (l) => (sessionListeners.push(l), () => {}) },
    navigation: { addInterceptor: (f) => (interceptors.push(f), () => {}) },
    internalPages: { register: (n, h) => void (pages[n] = h) },
    events: { on: (e, l) => ((events[e] ??= []).push(l as any), () => {}) },
    tabs: {
      getActive: () => tabs.get(1) ?? null,
      get: (id) => tabs.get(id) ?? null,
      list: () => [...tabs.values()],
      open: () => null,
      navigate: (tabId, url) => void navigations.push([tabId, url]),
      fromWebContentsId: (wc) => tabs.get(wcTabs.get(wc) ?? -1) ?? null,
      getPageContent: async () => null,
    },
    profiles: { list: () => [{ id: 'vit', name: 'VIT Chennai', color: '#fff', partition: 'persist:vit', isPrivate: false }], get: () => null },
    ipc: { handle: (m, fn) => void (ipc[m] = fn as any), emit: (e, p) => void emitted.push([e, p]) },
    system: { getIdleSeconds: () => 0 },
    net: {
      fetch: async (url: string) => {
        fetchCalls.push(url);
        return new Response(url.includes('easyprivacy') ? LIST : '! empty\n');
      },
    },
    notifications: { show: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  const createSession = (ctx: SessionContext) => {
    const l: Record<string, any> = {};
    const s: SessionLike = { webRequest: { onBeforeRequest: (f) => void (l.b = f), onBeforeSendHeaders: (f) => void (l.s = f), onHeadersReceived: (f) => void (l.r = f) } };
    sessionListeners.forEach((fn) => fn(s, ctx));
    return (d: Partial<ElectronRequestDetails>) =>
      new Promise<any>((res) => l.b({ id: 1, method: 'GET', resourceType: 'script', referrer: '', timestamp: 0, url: '', ...d }, res));
  };
  const addTab = (t: Partial<TabContext> & { tabId: number }, wc?: number) => {
    const tab: TabContext = { windowId: 1, url: 'https://news.site/', title: '', profileId: 'vit', workspaceId: null, isPrivate: false, ...t };
    tabs.set(t.tabId, tab);
    if (wc !== undefined) wcTabs.set(wc, t.tabId);
    return tab;
  };
  return {
    host, pages, ipc, navigations, emitted, interceptors, fetchCalls, addTab, createSession,
    shared: { db, dataDir, kv: kvMap },
    emit: <K extends keyof ShellEvents>(e: K, p: ShellEvents[K]) => events[e]?.forEach((l) => l(p)),
  };
}

const VIT: Ctx = { windowId: 1, profileId: 'vit', isPrivate: false };
const vitSession: SessionContext = { profileId: 'vit', partition: 'persist:vit', isPrivate: false };

describe('protection module', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date(2026, 9, 29, 10, 0).getTime(), toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('blocks trackers per profile, reports by tab id, and reuses cached lists after restart', async () => {
    const h = fakeHost();
    await createProtectionModule().activate(h.host);
    const request = h.createSession(vitSession);
    h.addTab({ tabId: 1 }, 77);
    await vi.waitFor(() => expect(h.ipc['privacy.panel']!({}, VIT).engine.state).toBe('ready'), { timeout: 3000 });
    await request({ resourceType: 'mainFrame', url: 'https://news.site/', webContentsId: 77 });
    const frame = { url: 'https://news.site/', top: { url: 'https://news.site/' } };
    expect(await request({ url: 'https://tracker.example/t.js', webContentsId: 77, frame })).toEqual({ cancel: true });
    expect(h.ipc['privacy.panel']!({ tabId: 1 }, VIT)).toMatchObject({ tabId: 1, site: 'news.site', tab: { blocked: 1 } });
    vi.advanceTimersByTime(500);
    expect(h.emitted).toContainEqual(['privacy-changed', { tabId: 1, blocked: 1 }]);

    h.ipc['privacy.setPreset']!({ preset: 'strict' }, VIT);
    h.ipc['privacy.setSiteException']!({ exception: { disableBlocking: true } }, VIT);
    expect(await request({ url: 'https://tracker.example/t.js', webContentsId: 77, frame })).toEqual({});
    await vi.waitFor(() => expect(h.ipc['privacy.panel']!({}, VIT).engine).toMatchObject({ key: 'ads+tracking+annoyances', state: 'ready' }), { timeout: 3000 });

    const h2 = fakeHost(h.shared);
    await createProtectionModule().activate(h2.host);
    h2.createSession(vitSession);
    expect(h2.ipc['privacy.getSettings']!({}, VIT)).toMatchObject({ preset: 'strict', siteExceptions: { 'news.site': { disableBlocking: true } } });
    await vi.waitFor(() => expect(h2.ipc['privacy.panel']!({}, VIT).engine.state).toBe('ready'), { timeout: 3000 });
    expect(h2.fetchCalls).toEqual([]);
  });

  it('keeps private-window settings changes out of the profile', async () => {
    const h = fakeHost();
    await createProtectionModule().activate(h.host);
    h.createSession(vitSession);
    h.createSession({ profileId: 'vit', partition: 'private-1', isPrivate: true });
    h.ipc['privacy.setPreset']!({ preset: 'strict' }, { ...VIT, isPrivate: true });
    expect(h.ipc['privacy.getSettings']!({}, VIT).preset).toBe('balanced');
  });

  it('falls back to http when an upgraded page fails to load', async () => {
    const h = fakeHost();
    await createProtectionModule().activate(h.host);
    const request = h.createSession(vitSession);
    h.ipc['privacy.setPreset']!({ preset: 'strict' }, VIT);
    expect(await request({ resourceType: 'mainFrame', url: 'http://old.example/' })).toEqual({ redirectURL: 'https://old.example/' });
    const tab = h.addTab({ tabId: 5, url: 'https://old.example/' });
    h.emit('tabLoadFailed', { ...tab, code: -107, description: 'ERR_SSL_PROTOCOL_ERROR', failedUrl: 'https://old.example/' });
    expect(h.navigations).toEqual([[5, 'http://old.example/']]);
    expect(await request({ resourceType: 'mainFrame', url: 'http://old.example/' })).toEqual({});
    // Unrelated failures are ignored.
    h.emit('tabLoadFailed', { ...tab, code: -105, description: 'ERR_NAME_NOT_RESOLVED', failedUrl: 'https://never-upgraded.example/' });
    expect(h.navigations).toHaveLength(1);
  });

  it('rejects malformed IPC payloads', async () => {
    const h = fakeHost();
    await createProtectionModule().activate(h.host);
    expect(() => h.ipc['focus.start']!({ mode: 'party' }, VIT)).toThrow();
    expect(() => h.ipc['activity.deleteRange']!('nope', VIT)).toThrow();
    expect(() => h.ipc['focus.start']!({ mode: 'study', timer: { workMinutes: 9999 } }, VIT)).toThrow();
  });

  it('intervenes via the navigation interceptor, network requests and in-page navigations', async () => {
    const h = fakeHost();
    await createProtectionModule().activate(h.host);
    const request = h.createSession(vitSession);
    h.ipc['focus.start']!({ mode: 'deep-work', goal: 'Lab report', timer: false }, VIT);
    const tab = h.addTab({ tabId: 3, url: 'https://docs.python.org/' }, 33);
    const d = await h.interceptors[0]!({ url: 'https://www.instagram.com/', source: 'omnibox', tab, profileId: 'vit', workspaceId: null, isPrivate: false });
    expect(d).toMatchObject({ action: 'redirect', url: expect.stringMatching(/^aether:\/\/intervention\/\?id=/) });
    const page = h.pages.intervention!(new URL((d as any).url), vitSession);
    expect(page.html).toContain('Lab report');
    const id = new URL((d as any).url).searchParams.get('id');
    expect(h.pages.intervention!(new URL(`aether://intervention/resolve?id=${id}&choice=back`), vitSession)).toEqual({ redirect: 'https://docs.python.org/' });

    expect(await request({ resourceType: 'mainFrame', url: 'https://netflix.com/', webContentsId: 33 })).toEqual({ cancel: true });
    expect(h.navigations.at(-1)).toEqual([3, expect.stringMatching(/^aether:\/\/intervention\//)]);

    h.emit('tabNavigated', { ...tab, url: 'https://www.youtube.com/shorts/x', inPage: true });
    expect(h.navigations).toHaveLength(2);
  });

  it('tracks time into the dashboard and restores focus state after restart', async () => {
    const h = fakeHost();
    await createProtectionModule().activate(h.host);
    h.emit('windowFocusChanged', { windowId: 1, focused: true, profileId: 'vit', isPrivate: false });
    h.emit('activeTabChanged', { tabId: 1, windowId: 1, url: 'https://arxiv.org/abs/1', title: '', profileId: 'vit', workspaceId: 'radar', isPrivate: false });
    h.ipc['focus.start']!({ mode: 'study', goal: 'Radar', timer: { workMinutes: 25 } }, VIT);
    vi.advanceTimersByTime(20 * 60_000);
    const report = h.ipc['activity.report']!({ range: 'today' }, VIT);
    expect(report.byDomain[0]).toMatchObject({ domain: 'arxiv.org', category: 'research' });
    expect(report.totals.active).toBe(20 * 60_000);
    const dash = h.pages.activity!(new URL('aether://activity/?range=today'), vitSession);
    expect(dash.html).toContain('arxiv.org');
    h.emit('appWillQuit', {});

    const h2 = fakeHost(h.shared);
    await createProtectionModule().activate(h2.host);
    expect(h2.ipc['focus.status']!({}, VIT)).toMatchObject({ active: true, session: { goal: 'Radar' } });
    h2.ipc['focus.end']!({}, VIT);
    expect(h2.ipc['activity.report']!({ range: 'today' }, VIT).focusSessions).toHaveLength(1);
  });

  it('keeps private windows out of activity history and deletes data with the profile', async () => {
    const h = fakeHost();
    await createProtectionModule().activate(h.host);
    h.emit('windowFocusChanged', { windowId: 2, focused: true, profileId: 'vit', isPrivate: true });
    h.emit('activeTabChanged', { tabId: 9, windowId: 2, url: 'https://secret.example/', title: '', profileId: 'vit', workspaceId: null, isPrivate: true });
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.ipc['activity.report']!({ range: 'today' }, VIT).totals.active).toBe(0);
    h.emit('windowFocusChanged', { windowId: 1, focused: true, profileId: 'vit', isPrivate: false });
    h.emit('activeTabChanged', { tabId: 1, windowId: 1, url: 'https://arxiv.org/', title: '', profileId: 'vit', workspaceId: null, isPrivate: false });
    vi.advanceTimersByTime(5 * 60_000);
    h.emit('profileDeleted', { profileId: 'vit' });
    h.emit('windowClosed', { windowId: 1 });
    expect(h.ipc['activity.report']!({ range: 'today' }, VIT).totals.active).toBe(0);
  });
});
