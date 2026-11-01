import { rmSync } from 'node:fs';
import { app, dialog, nativeTheme, powerMonitor, type WebContents } from 'electron';
import { DEFAULT_THEME, resolveTheme, THEMES, type Theme } from '../shared/themes';
import type { AetherMainModule, PageContent, TabContext } from '@aether/plugin-api';
import type { AetherStore } from '@aether/storage';
import type { PermissionPrompt, ProfileSummary, WorkspaceSummary } from '../shared/types';
import { DownloadManager } from './downloads';
import { FaviconCache } from './favicons';
import { InternalPages } from './internal-pages';
import { ModuleHost } from './module-host';
import { ReaderStore } from './reader';
import { ExtensionManager } from './extensions';
import { PasswordManager } from './passwords';
import { SessionRegistry } from './sessions';
import type { Tab } from './tab';
import { BrowserWindowController, NEW_TAB_URL, type WindowInit } from './window';

export interface ShellOptions {
  store: AetherStore;
  uiUrl: string;
  isDev: boolean;
  iconPath?: string;
  userDataDir: string;
}

/**
 * Application-wide state: windows, sessions, modules. One instance per process.
 */
export class Shell {
  readonly store: AetherStore;
  readonly uiUrl: string;
  readonly isDev: boolean;
  readonly iconPath?: string;
  readonly pages: InternalPages;
  readonly sessions: SessionRegistry;
  readonly modules: ModuleHost;
  readonly downloads: DownloadManager;
  readonly passwords: PasswordManager;
  readonly favicons = new FaviconCache();
  readonly reader = new ReaderStore();
  readonly extensions: ExtensionManager;
  readonly windows = new Map<number, BrowserWindowController>();
  lastFocused: BrowserWindowController | null = null;
  quitting = false;

  private tabContents = new Map<number, { win: BrowserWindowController; tab: Tab }>();
  private permissionRequests = new Map<number, (r: { allow: boolean; remember: boolean }) => void>();
  private nextPermissionId = 1;
  private sleepTimer: NodeJS.Timeout;
  private checkpointTimer: NodeJS.Timeout;

  constructor(opts: ShellOptions) {
    this.store = opts.store;
    this.uiUrl = opts.uiUrl;
    this.isDev = opts.isDev;
    this.iconPath = opts.iconPath;
    this.pages = new InternalPages({ store: this.store, version: app.getVersion(), theme: () => this.theme(), reader: this.reader });
    nativeTheme.on('updated', () => {
      if (this.themeId() === 'system') for (const w of this.windows.values()) w.onTheme();
    });
    this.downloads = new DownloadManager(this.store, (profileId, isPrivate, partition) => {
      for (const w of this.windows.values()) {
        if (w.profileId === profileId && w.isPrivate === isPrivate && (!isPrivate || w.partition() === partition)) w.send('downloads', this.downloads.list({ profileId, isPrivate, partition }));
      }
    });
    this.passwords = new PasswordManager(this);
    this.extensions = new ExtensionManager(this.store);
    this.downloads.onCompleted = (ctx, path) => void this.passwords.downloadCompleted(ctx.profileId, ctx.isPrivate, path);
    this.sessions = new SessionRegistry(
      this.store,
      this.pages,
      { ask: (wcId, origin, permission) => this.askPermission(wcId, origin, permission) },
      {
        onCreated: (ses, ctx) => this.modules?.sessionCreated(ses as never, ctx),
        onDownload: (ses, ctx) => this.downloads.attach(ses, ctx),
        onExtensions: (ses, ctx) => this.extensions.loadAll(ses, ctx.profileId),
      },
    );
    this.modules = new ModuleHost({
      store: this.store,
      userDataDir: opts.userDataDir,
      registerInternalPage: (name, handler) => this.pages.register(name, handler),
      existingSessions: () => this.sessions.all() as never,
      tabs: this.tabsApi(),
      profiles: {
        list: () => this.store.listProfiles().map((p) => ({ id: p.id, name: p.name, color: p.color, partition: SessionRegistry.partitionForProfile(p.id), isPrivate: false })),
        get: (id) => {
          const p = this.store.getProfile(id);
          return p ? { id: p.id, name: p.name, color: p.color, partition: SessionRegistry.partitionForProfile(p.id), isPrivate: false } : null;
        },
      },
      getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      shellData: {
        exportSyncData: (profileId) => this.exportSyncData(profileId),
        importSyncData: (profileId, data) => this.importSyncData(profileId, data),
      },
      emitToUi: (event, payload, windowId) => {
        for (const w of this.windows.values()) if (windowId === undefined || w.id === windowId) w.send('module-event', { event, payload });
      },
    });

    powerMonitor.on('suspend', () => this.modules.emit('systemSuspended', { reason: 'suspend' }));
    powerMonitor.on('lock-screen', () => this.modules.emit('systemSuspended', { reason: 'lock-screen' }));
    powerMonitor.on('resume', () => this.modules.emit('systemResumed', { reason: 'resume' }));
    powerMonitor.on('unlock-screen', () => this.modules.emit('systemResumed', { reason: 'unlock-screen' }));

    // Memory saver: discard background tabs idle for N minutes.
    this.sleepTimer = setInterval(() => this.sleepIdleTabs(), 60_000);
    // Reading positions for visible tabs, so a crash loses at most ~30s.
    this.checkpointTimer = setInterval(() => {
      for (const w of this.windows.values()) void w.captureScrollPositions().then(() => w.schedulePersist());
    }, 30_000);
  }

  async loadModules(mods: AetherMainModule[]): Promise<void> {
    await this.modules.load(mods);
  }

  async loadInstallable(list: Parameters<ModuleHost['loadInstallable']>[0], gate: Parameters<ModuleHost['loadInstallable']>[1]): Promise<void> {
    await this.modules.loadInstallable(list, gate);
  }

  // ---------------------------------------------------------------------------
  // Windows
  // ---------------------------------------------------------------------------

  openWindow(init: WindowInit): BrowserWindowController {
    const w = new BrowserWindowController(this, init);
    this.windows.set(w.id, w);
    this.lastFocused = w;
    return w;
  }

  windowClosed(w: BrowserWindowController): void {
    this.windows.delete(w.id);
    for (const [id, entry] of this.tabContents) if (entry.win === w) this.tabContents.delete(id);
    if (this.lastFocused === w) this.lastFocused = [...this.windows.values()].pop() ?? null;
    this.broadcastState();
  }

  fromWebContents(wc: WebContents): BrowserWindowController | undefined {
    for (const w of this.windows.values()) if (w.webContents === wc) return w;
    return undefined;
  }

  tabByWebContents(wcId: number): { win: BrowserWindowController; tab: Tab } | undefined {
    return this.tabContents.get(wcId);
  }

  registerTabContents(wcId: number, win: BrowserWindowController, tab: Tab): void {
    this.tabContents.set(wcId, { win, tab });
  }

  broadcastState(): void {
    for (const w of this.windows.values()) w.changed();
  }

  /**
   * Startup: reopen every window that was open at quit/crash and every window
   * the user chose to keep, for profiles with restore enabled.
   */
  restoreOrOpen(): void {
    this.cleanupPendingDeletes();
    this.store.markStaleDownloadsInterrupted();
    if (this.store.listProfiles().length === 0) this.store.createProfile({ name: 'Personal', color: '#7c8cff' });
    const restorable = this.store.listProfiles().filter((p) => p.restoreOnStartup);
    let opened = 0;
    for (const p of restorable) opened += this.restoreProfileWindows(p.id);
    if (opened === 0) {
      const lastProfile = this.store.getSetting<string | null>('lastProfileId', null);
      const profile = (lastProfile && this.store.getProfile(lastProfile)) || this.store.listProfiles()[0];
      this.openWindow({ profileId: profile.id });
    }
  }

  restoreProfileWindows(profileId: string): number {
    const sessions = this.store.listWindowSessions(profileId).reverse();
    for (const s of sessions) this.restoreSession(s.id);
    return sessions.length;
  }

  restoreSession(id: string): BrowserWindowController | null {
    for (const w of this.windows.values()) if (w.sessionId === id) {
      w.win.focus();
      return w;
    }
    const s = this.store.getWindowSession(id);
    if (!s || !this.store.getProfile(s.profileId)) return null;
    const ws = s.workspaceId ? this.store.getWorkspace(s.workspaceId) : null;
    const tabs = ws && ws.tabs.length ? ws.tabs : s.tabs;
    const w = this.openWindow({
      profileId: s.profileId,
      sessionId: s.id,
      workspaceId: ws?.id ?? null,
      tabs,
      activeIndex: ws ? ws.activeIndex : s.activeIndex,
      bounds: s.bounds,
      maximized: s.maximized,
      split: ws ? null : s.split,
    });
    this.store.saveWindowSession({ ...s, state: 'open' });
    return w;
  }

  /** Opens a profile: restores its kept windows, or opens a fresh window. */
  openProfile(profileId: string): void {
    this.store.setSetting('lastProfileId', profileId);
    const open = [...this.windows.values()].filter((w) => w.profileId === profileId && !w.isPrivate);
    const saved = this.store.listWindowSessions(profileId, 'saved');
    if (saved.length && open.length === 0) {
      for (const s of saved.reverse()) this.restoreSession(s.id);
      return;
    }
    this.openWindow({ profileId });
  }

  /** Quit: keep all windows as "open" unless their profile discards on close. */
  async prepareQuit(): Promise<void> {
    await Promise.all([...this.windows.values()].map((w) => w.captureScrollPositions(true).catch(() => {})));
    for (const w of this.windows.values()) {
      if (w.isPrivate) continue;
      const behavior = this.store.getProfile(w.profileId)?.closeBehavior;
      if (behavior === 'discard' && !w.workspaceId) this.store.deleteWindowSession(w.sessionId);
      else w.persistNow('open');
      w.closing = true;
    }
    clearInterval(this.sleepTimer);
    clearInterval(this.checkpointTimer);
    this.modules.emit('appWillQuit', {});
    await this.modules.unloadAll();
  }

  themeId(): string {
    return this.store.getSetting<string>('theme', DEFAULT_THEME);
  }

  theme(): Theme {
    return resolveTheme(this.themeId(), nativeTheme.shouldUseDarkColors);
  }

  setTheme(id: string): void {
    if (id !== 'system' && !THEMES[id]) throw new Error('Unknown theme');
    this.store.setSetting('theme', id);
    for (const w of this.windows.values()) w.onTheme();
  }

  sleepAfterMinutes(): number {
    return this.store.getSetting<number>('sleepAfterMinutes', 20);
  }

  private sleepIdleTabs(): void {
    const minutes = this.sleepAfterMinutes();
    if (!minutes) return;
    const cutoff = Date.now() - minutes * 60_000;
    for (const w of this.windows.values()) {
      const visible = new Set(w.visibleTabs());
      for (const t of w.tabs) {
        if (visible.has(t) || t.sleeping || t.lastActiveAt > cutoff) continue;
        const wc = t.wc;
        if (wc && (wc.isCurrentlyAudible() || wc.isDevToolsOpened())) continue;
        void w.sleepTab(t.id);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Summaries for the UI
  // ---------------------------------------------------------------------------

  profileSummaries(): ProfileSummary[] {
    const sessions = this.store.listWindowSessions(undefined, 'saved');
    return this.store.listProfiles().map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      icon: p.icon,
      searchEngine: p.searchEngine,
      closeBehavior: p.closeBehavior,
      restoreOnStartup: p.restoreOnStartup,
      openWindows: [...this.windows.values()].filter((w) => w.profileId === p.id && !w.isPrivate).length,
      savedWindows: sessions.filter((s) => s.profileId === p.id).length,
    }));
  }

  workspaceSummaries(profileId: string): WorkspaceSummary[] {
    return this.store.listWorkspaces(profileId).map((ws) => ({
      id: ws.id,
      name: ws.name,
      color: ws.color,
      icon: ws.icon,
      tabCount: ws.tabs.length,
      updatedAt: ws.updatedAt,
      openIn: [...this.windows.values()].find((w) => w.workspaceId === ws.id)?.id ?? null,
    }));
  }

  /** Bumped on every bookmark change so the bookmarks bar knows to reload. */
  bookmarksRev = 0;

  bookmarksBarVisible(): boolean {
    return this.store.getSetting<boolean>('bookmarksBar', true);
  }

  toggleBookmarksBar(): void {
    this.store.setSetting('bookmarksBar', !this.bookmarksBarVisible());
    this.broadcastState();
  }

  bookmarksChanged(): void {
    this.bookmarksRev++;
    this.broadcastState();
  }

  toggleBookmark(w: BrowserWindowController, tab: Tab): boolean {
    const existing = this.store.findBookmarkByUrl(w.profileId, tab.url);
    if (existing) this.store.deleteBookmark(w.profileId, existing.id);
    else this.store.addBookmark(w.profileId, { title: tab.title || tab.url, url: tab.url });
    this.bookmarksChanged();
    return !existing;
  }

  // ---------------------------------------------------------------------------
  // Profiles
  // ---------------------------------------------------------------------------

  async deleteProfile(profileId: string, parent: BrowserWindowController): Promise<boolean> {
    const profiles = this.store.listProfiles();
    const profile = profiles.find((p) => p.id === profileId);
    if (!profile) return false;
    if (profiles.length <= 1) {
      await dialog.showMessageBox(parent.win, { type: 'info', message: 'You need at least one profile.', detail: 'Create another profile before deleting this one.' });
      return false;
    }
    const s = this.store.profileDataSummary(profileId);
    const { response } = await dialog.showMessageBox(parent.win, {
      type: 'warning',
      title: 'Delete profile',
      message: `Delete “${profile.name}” from this device?`,
      detail:
        `This permanently removes, on this computer only:\n` +
        `• all cookies and website sign-ins, site storage and cache for this profile\n` +
        `• ${s.history} history entries, ${s.bookmarks} bookmarks, ${s.workspaces} workspaces and ${s.windows} kept windows\n` +
        `• the list of ${s.downloads} downloads (downloaded files themselves are not deleted)\n` +
        `• site permissions and settings stored by AETHER modules for this profile\n\n` +
        `Accounts on websites (Google, university portals) are not deleted; you are only signed out here. Export the profile first if you want a copy.`,
      buttons: ['Delete profile', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return false;
    for (const w of [...this.windows.values()]) if (w.profileId === profileId) {
      w.closing = true;
      w.win.destroy();
    }
    const dir = await this.sessions.wipeProfile(profileId);
    this.store.deleteProfile(profileId);
    this.modules.emit('profileDeleted', { profileId });
    if (dir) {
      const pending = this.store.getSetting<string[]>('pendingPartitionDeletes', []);
      this.store.setSetting('pendingPartitionDeletes', [...pending, dir]);
    }
    if (this.windows.size === 0) this.openWindow({ profileId: this.store.listProfiles()[0].id });
    this.broadcastState();
    return true;
  }

  /** Partition folders are locked while their session lives; remove them at next start. */
  private cleanupPendingDeletes(): void {
    const pending = this.store.getSetting<string[]>('pendingPartitionDeletes', []);
    const userData = app.getPath('userData');
    const left = pending.filter((dir) => {
      if (!dir.startsWith(userData)) return false;
      try {
        rmSync(dir, { recursive: true, force: true });
        return false;
      } catch {
        return true;
      }
    });
    this.store.setSetting('pendingPartitionDeletes', left);
  }

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------

  private askPermission(wcId: number, origin: string, permission: string): Promise<{ allow: boolean; remember: boolean }> {
    const entry = this.tabContents.get(wcId);
    if (!entry) return Promise.resolve({ allow: false, remember: false });
    const requestId = this.nextPermissionId++;
    const prompt: PermissionPrompt = { requestId, tabId: entry.tab.id, origin, permission };
    entry.win.send('permission', prompt);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.permissionRequests.delete(requestId);
        resolve({ allow: false, remember: false });
      }, 120_000);
      this.permissionRequests.set(requestId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
  }

  respondPermission(requestId: number, allow: boolean, remember: boolean): void {
    const fn = this.permissionRequests.get(requestId);
    this.permissionRequests.delete(requestId);
    fn?.({ allow, remember });
  }

  // ---------------------------------------------------------------------------
  // Tabs API for modules
  // ---------------------------------------------------------------------------

  private findTab(tabId: number): { win: BrowserWindowController; tab: Tab } | null {
    for (const win of this.windows.values()) {
      const tab = win.tabs.find((t) => t.id === tabId);
      if (tab) return { win, tab };
    }
    return null;
  }

  /** Bookmarks (with folder paths), theme and search engine, for Google Drive sync. */
  exportSyncData(profileId: string): Record<string, unknown> {
    const all = this.store.allBookmarks(profileId);
    const byId = new Map(all.map((b) => [b.id, b]));
    const path = (b: { parentId: number | null }): string[] => {
      const out: string[] = [];
      let p = b.parentId;
      while (p !== null && byId.has(p)) {
        const f = byId.get(p)!;
        out.unshift(f.title);
        p = f.parentId;
      }
      return out;
    };
    const profile = this.store.getProfile(profileId);
    return {
      format: 'aether-sync/1',
      exportedAt: new Date().toISOString(),
      bookmarks: all.filter((b) => b.url).map((b) => ({ title: b.title, url: b.url, folder: path(b) })),
      theme: this.store.getSetting<string>('theme', DEFAULT_THEME),
      searchEngine: profile?.searchEngine,
    };
  }

  /** Merges synced bookmarks (adds the ones missing by URL, recreating folders). */
  importSyncData(profileId: string, data: Record<string, unknown>): { added: number } {
    const list = Array.isArray(data.bookmarks) ? (data.bookmarks as { title?: unknown; url?: unknown; folder?: unknown }[]) : [];
    let added = 0;
    const folderCache = new Map<string, number | null>();
    const folderFor = (names: string[]): number | null => {
      let parent: number | null = null;
      const key: string[] = [];
      for (const n of names.slice(0, 8)) {
        key.push(n);
        const k = key.join('/');
        if (folderCache.has(k)) {
          parent = folderCache.get(k)!;
          continue;
        }
        const existing: { id: number } | undefined = this.store.listBookmarks(profileId, parent).find((b) => b.url === null && b.title === n);
        parent = existing ? existing.id : this.store.addBookmark(profileId, { title: n, url: null, parentId: parent }).id;
        folderCache.set(k, parent);
      }
      return parent;
    };
    for (const b of list.slice(0, 20000)) {
      if (typeof b.url !== 'string' || !/^https?:\/\//.test(b.url) || this.store.findBookmarkByUrl(profileId, b.url)) continue;
      const folder = Array.isArray(b.folder) ? b.folder.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 200)) : [];
      this.store.addBookmark(profileId, { title: typeof b.title === 'string' ? b.title : b.url, url: b.url, parentId: folderFor(folder) });
      added++;
    }
    if (added) this.broadcastState();
    return { added };
  }

  private tabsApi() {
    const ctx = (win: BrowserWindowController, tab: Tab): TabContext => win.tabContext(tab);
    return {
      getActive: (windowId: number) => {
        const w = this.windows.get(windowId);
        const t = w?.activeTab;
        return w && t ? ctx(w, t) : null;
      },
      get: (tabId: number) => {
        const f = this.findTab(tabId);
        return f ? ctx(f.win, f.tab) : null;
      },
      list: (windowId?: number) => [...this.windows.values()].filter((w) => windowId === undefined || w.id === windowId).flatMap((w) => w.tabs.map((t) => ctx(w, t))),
      open: (windowId: number, url: string, opts?: { background?: boolean }) => {
        const w = this.windows.get(windowId);
        return w ? w.openTab(url, { background: opts?.background, afterActive: true, source: 'module' }).id : null;
      },
      navigate: (tabId: number, url: string) => {
        const f = this.findTab(tabId);
        if (f) void f.win.navigateTab(f.tab, url, 'module', false);
      },
      fromWebContentsId: (wcId: number) => {
        const e = this.tabContents.get(wcId);
        return e && e.win.tabs.includes(e.tab) ? ctx(e.win, e.tab) : null;
      },
      getPageContent: async (tabId: number): Promise<PageContent | null> => {
        const f = this.findTab(tabId);
        return f ? ((await f.win.getPageContent(f.tab)) as PageContent | null) : null;
      },
      savePage: async (tabId: number, filePath: string): Promise<boolean> => {
        const wc = this.findTab(tabId)?.tab.wc;
        if (!wc || !/^https?:|^file:/.test(wc.getURL())) return false;
        await wc.savePage(filePath, 'MHTML');
        return true;
      },
    };
  }
}

export { NEW_TAB_URL };
