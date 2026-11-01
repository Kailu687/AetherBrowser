import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BrowserWindow, clipboard, dialog, Menu, screen, type Input, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron';
import { GROUP_COLORS, type GroupColor, type TabGroup } from '../shared/types';
import type { NavigationRequest, TabContext } from '@aether/plugin-api';
import type { Bounds, SavedTab, WindowSession } from '@aether/storage';
import { quickCalc, resolveOmniboxInput } from '@aether/omnibox';
import type { Rect, SplitState, UiCommand, WindowState } from '../shared/types';
import { PAGE_CONTENT_SCRIPT, ISOLATED_WORLD, Tab } from './tab';
import type { Shell } from './shell';
import { ReaderStore } from './reader';

const NEW_TAB_URL = 'aether://newtab/';
const DIVIDER = 6;
const TITLEBAR_HEIGHT = 40;

export interface WindowInit {
  profileId: string;
  isPrivate?: boolean;
  sessionId?: string;
  workspaceId?: string | null;
  tabs?: SavedTab[];
  activeIndex?: number;
  bounds?: Bounds | null;
  maximized?: boolean;
  split?: { left: number; right: number; ratio: number } | null;
}

/** Keyboard shortcut table, shared by the UI and every tab in the window. */
function shortcutFor(input: Input, isMac: boolean): string | null {
  if (input.type !== 'keyDown') return null;
  const mod = isMac ? input.meta : input.control;
  const parts: string[] = [];
  if (mod) parts.push('Mod');
  if (input.shift) parts.push('Shift');
  if (input.alt) parts.push('Alt');
  let key = input.key.length === 1 ? input.key.toUpperCase() : input.key;
  if (key === '+') key = '=';
  parts.push(key);
  return parts.join('+');
}

export class BrowserWindowController {
  readonly win: BrowserWindow;
  readonly id: number;
  readonly sessionId: string;
  readonly isPrivate: boolean;
  readonly profileId: string;
  readonly session: Session;
  workspaceId: string | null;
  tabs: Tab[] = [];
  activeTabId: number | null = null;
  split: SplitState | null = null;
  groups = new Map<string, TabGroup>();
  /** Pending save-password offer; the password stays in the main process. */
  loginOffer: { tabId: number; url: string; site: string; username: string; password: string; update: boolean; at: number } | null = null;
  private closedTabs: SavedTab[] = [];
  private contentRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private overlay = false;
  private stateTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private closeConfirmed = false;
  private uiReady = false;
  private typedNavigation = new WeakSet<Tab>();
  closing = false;

  constructor(
    private shell: Shell,
    init: WindowInit,
  ) {
    this.profileId = init.profileId;
    this.isPrivate = !!init.isPrivate;
    this.sessionId = init.sessionId ?? randomUUID();
    this.workspaceId = init.workspaceId ?? null;
    this.session = this.isPrivate ? shell.sessions.createPrivate(this.profileId) : shell.sessions.forProfile(this.profileId);

    const bounds = sanitizeBounds(init.bounds ?? null);
    const theme = shell.theme();
    this.win = new BrowserWindow({
      ...bounds,
      minWidth: 480,
      minHeight: 360,
      show: false,
      title: 'AETHER',
      backgroundColor: theme.tokens.chrome,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      titleBarOverlay: process.platform === 'darwin' ? undefined : { color: '#00000000', symbolColor: theme.tokens.fg, height: TITLEBAR_HEIGHT },
      icon: shell.iconPath,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: true,
        devTools: shell.isDev,
        partition: 'aether-ui',
      },
    });
    this.id = this.win.id;
    if (init.maximized) this.win.maximize();
    this.wireWindow();
    void this.win.loadURL(shell.uiUrl);

    const saved = init.tabs?.length ? init.tabs : [{ url: NEW_TAB_URL, title: 'New Tab' }];
    for (const t of saved) this.tabs.push(this.makeTab(t));
    const active = this.tabs[Math.min(Math.max(init.activeIndex ?? 0, 0), this.tabs.length - 1)];
    if (init.split) {
      const l = this.tabs[init.split.left];
      const r = this.tabs[init.split.right];
      if (l && r && l !== r) this.split = { leftTabId: l.id, rightTabId: r.id, ratio: clampRatio(init.split.ratio) };
    }
    this.activate(active.id);
  }

  // ---------------------------------------------------------------------------
  // Context helpers
  // ---------------------------------------------------------------------------

  get webContents(): WebContents {
    return this.win.webContents;
  }

  get activeTab(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeTabId) ?? null;
  }

  tabContext(tab: Tab): TabContext {
    return { tabId: tab.id, windowId: this.id, url: tab.url, title: tab.title, profileId: this.profileId, workspaceId: this.workspaceId, isPrivate: this.isPrivate };
  }

  partition(): string {
    return this.shell.sessions.context(this.session)?.partition ?? '';
  }

  send(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed() && !this.webContents.isDestroyed()) this.webContents.send(channel, payload);
  }

  command(cmd: UiCommand): void {
    this.send('command', cmd);
    if (cmd !== 'escape') this.webContents.focus();
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  private makeTab(saved: SavedTab): Tab {
    const tab = new Tab(this.session, { changed: () => this.changed(), attach: (t, wc) => this.attachWebContents(t, wc) }, saved);
    tab.pane = saved.pane;
    if (saved.group && !tab.pinned) {
      const g = saved.group;
      if (!this.groups.has(g.id)) {
        const color = (GROUP_COLORS as readonly string[]).includes(g.color) ? (g.color as GroupColor) : 'grey';
        this.groups.set(g.id, { id: g.id, title: String(g.title ?? '').slice(0, 60), color, collapsed: !!g.collapsed });
      }
      tab.groupId = g.id;
    }
    return tab;
  }

  /** A tab as saved to disk, with its group's details. */
  private savedOf(t: Tab): SavedTab {
    const saved = t.toSaved();
    const g = t.groupId ? this.groups.get(t.groupId) : undefined;
    if (g) saved.group = { id: g.id, title: g.title, color: g.color, ...(g.collapsed ? { collapsed: true } : {}) };
    return saved;
  }

  // ---------------------------------------------------------------------------
  // Tab groups (members are always contiguous; pinned tabs are never grouped)
  // ---------------------------------------------------------------------------

  createGroup(tabIds: number[], title = '', color?: GroupColor): string {
    const members = this.tabs.filter((t) => tabIds.includes(t.id) && !t.pinned);
    if (!members.length) throw new Error('No tabs to group');
    const used = new Set([...this.groups.values()].map((g) => g.color));
    const id = randomUUID();
    this.groups.set(id, { id, title: title.slice(0, 60), color: color ?? GROUP_COLORS.find((c) => c !== 'grey' && !used.has(c)) ?? 'blue', collapsed: false });
    for (const t of members) t.groupId = id;
    this.normalizeGroups();
    return id;
  }

  setTabGroup(tabId: number, groupId: string | null): void {
    const t = this.tabs.find((x) => x.id === tabId);
    if (!t || t.pinned || (groupId && !this.groups.has(groupId))) return;
    t.groupId = groupId;
    this.normalizeGroups();
  }

  updateGroup(id: string, patch: { title?: string; color?: GroupColor; collapsed?: boolean }): void {
    const g = this.groups.get(id);
    if (!g) return;
    if (patch.title !== undefined) g.title = patch.title.slice(0, 60);
    if (patch.color) g.color = patch.color;
    if (patch.collapsed !== undefined) {
      g.collapsed = patch.collapsed;
      // Collapsing the group that holds the active tab moves focus to a visible tab.
      const active = this.activeTab;
      if (g.collapsed && active?.groupId === id) {
        const next = this.tabs.find((t) => t.groupId !== id);
        if (next) this.activate(next.id);
        else g.collapsed = false;
      }
    }
    this.changed();
  }

  ungroup(id: string): void {
    for (const t of this.tabs) if (t.groupId === id) t.groupId = null;
    this.groups.delete(id);
    this.changed();
  }

  closeGroup(id: string): void {
    for (const t of this.tabs.filter((x) => x.groupId === id)) this.closeTab(t.id);
    this.groups.delete(id);
    this.changed();
  }

  /** Keeps each group's tabs together (at its first member's position) and drops empty groups. */
  private normalizeGroups(): void {
    const out: Tab[] = [];
    const placed = new Set<string>();
    for (const t of this.tabs) {
      if (!t.groupId) out.push(t);
      else if (!placed.has(t.groupId)) {
        placed.add(t.groupId);
        out.push(...this.tabs.filter((x) => x.groupId === t.groupId));
      }
    }
    this.tabs = out;
    for (const id of [...this.groups.keys()]) if (!placed.has(id)) this.groups.delete(id);
    this.changed();
  }

  openTab(url: string, opts: { background?: boolean; afterActive?: boolean; source?: NavigationRequest['source'] } = {}): Tab {
    const tab = this.makeTab({ url: NEW_TAB_URL, title: 'New Tab' });
    const idx = opts.afterActive && this.activeTab ? this.tabs.indexOf(this.activeTab) + 1 : this.tabs.length;
    this.tabs.splice(idx, 0, tab);
    tab.url = url;
    if (url !== NEW_TAB_URL) {
      tab.holdLoad = true;
      void this.navigateTab(tab, url, opts.source ?? 'module', false);
    }
    if (!opts.background) this.activate(tab.id);
    else this.changed();
    return tab;
  }

  activate(tabId: number): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    this.activeTabId = tab.id;
    tab.lastActiveAt = Date.now();
    const group = tab.groupId ? this.groups.get(tab.groupId) : undefined;
    if (group?.collapsed) group.collapsed = false;
    // Leaving split view when activating a tab outside it.
    if (this.split && tab.id !== this.split.leftTabId && tab.id !== this.split.rightTabId) this.split = null;
    for (const t of this.visibleTabs()) this.ensureAwake(t);
    this.layout();
    this.changed();
    this.shell.modules.emit('activeTabChanged', this.tabContext(tab));
    if (tab.url === NEW_TAB_URL) this.command('focus-address');
    else tab.wc?.focus();
  }

  private ensureAwake(tab: Tab): void {
    if (tab.wake()) {
      this.win.contentView.addChildView(tab.view!);
      tab.view!.setVisible(false);
    }
  }

  closeTab(tabId: number): void {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const tab = this.tabs[idx];
    if (!this.isPrivate && tab.url !== NEW_TAB_URL) {
      this.closedTabs.push(this.savedOf(tab));
      if (this.closedTabs.length > 25) this.closedTabs.shift();
    }
    if (tab.view) this.win.contentView.removeChildView(tab.view);
    tab.destroy();
    this.tabs.splice(idx, 1);
    if (tab.groupId && !this.tabs.some((t) => t.groupId === tab.groupId)) this.groups.delete(tab.groupId);
    this.shell.modules.emit('tabClosed', { tabId, windowId: this.id });
    if (this.split && (this.split.leftTabId === tabId || this.split.rightTabId === tabId)) this.split = null;
    if (this.tabs.length === 0) {
      this.win.close();
      return;
    }
    if (this.activeTabId === tabId) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.activate(next.id);
    } else {
      this.layout();
      this.changed();
    }
  }

  reopenClosedTab(): void {
    const saved = this.closedTabs.pop();
    if (!saved) return;
    const tab = this.makeTab(saved);
    this.tabs.push(tab);
    this.activate(tab.id);
  }

  moveTab(tabId: number, toIndex: number): void {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const [tab] = this.tabs.splice(idx, 1);
    const at = Math.max(0, Math.min(toIndex, this.tabs.length));
    this.tabs.splice(at, 0, tab);
    // Dropped inside a group joins it; dropped outside its group leaves it.
    const prev = this.tabs[at - 1];
    const next = this.tabs[at + 1];
    if (!tab.pinned) {
      if (prev?.groupId && prev.groupId === next?.groupId) tab.groupId = prev.groupId;
      else if (tab.groupId && prev?.groupId !== tab.groupId && next?.groupId !== tab.groupId) tab.groupId = null;
    }
    this.normalizeGroups();
  }

  /** Discards a background tab to free memory. */
  async sleepTab(tabId: number): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || tab.id === this.activeTabId) return;
    if (tab.view) this.win.contentView.removeChildView(tab.view);
    await tab.sleep();
    this.changed();
  }

  async navigateTab(tab: Tab, url: string, source: NavigationRequest['source'], typed: boolean): Promise<void> {
    const decision = await this.shell.modules.decide({
      url,
      source,
      tab: this.tabContext(tab),
      profileId: this.profileId,
      workspaceId: this.workspaceId,
      isPrivate: this.isPrivate,
    });
    if (decision.action === 'block') url = `aether://blocked?url=${encodeURIComponent(url)}&reason=${encodeURIComponent(decision.reason)}`;
    else if (decision.action === 'redirect') url = decision.url;
    if (typed) this.typedNavigation.add(tab);
    const wasSleeping = tab.sleeping;
    tab.navigate(url);
    if (wasSleeping && tab.view) {
      this.win.contentView.addChildView(tab.view);
      this.layout();
    }
  }

  /** Address-bar entry point. */
  /** Opens the reader view for a web page, or returns from it to the original. */
  async toggleReader(t: Tab): Promise<boolean> {
    const src = ReaderStore.sourceOf(t.url);
    if (src) {
      this.navigateFromOmnibox(src, t.id);
      return false;
    }
    if (!t.wc || !/^https?:/i.test(t.url)) throw new Error('Reader view works on web pages only');
    const article = await this.shell.reader.extract(t.wc);
    if (!article) {
      this.send('toast', { kind: 'info', text: 'No article found on this page.' });
      return false;
    }
    void t.wc.loadURL(this.shell.reader.put(article, t.wc.getURL(), this.partition()));
    return true;
  }

  navigateFromOmnibox(input: string, tabId?: number): void {
    const tab = this.tabs.find((t) => t.id === (tabId ?? this.activeTabId));
    if (!tab) return;
    const engine = this.shell.store.getProfile(this.profileId)?.searchEngine ?? 'google';
    const r = resolveOmniboxInput(input, { engine });
    if (r.kind === 'invalid') {
      this.send('toast', { kind: 'error', text: r.reason === 'empty' ? 'Type something to search or a URL to open.' : r.reason });
      return;
    }
    void this.navigateTab(tab, r.url, 'omnibox', true);
    tab.wc?.focus();
  }

  visibleTabs(): Tab[] {
    if (this.split) {
      return [this.split.leftTabId, this.split.rightTabId].map((id) => this.tabs.find((t) => t.id === id)).filter((t): t is Tab => !!t);
    }
    const a = this.activeTab;
    return a ? [a] : [];
  }

  setSplit(leftTabId: number, rightTabId: number, ratio = 0.5): void {
    if (leftTabId === rightTabId) return;
    const l = this.tabs.find((t) => t.id === leftTabId);
    const r = this.tabs.find((t) => t.id === rightTabId);
    if (!l || !r) return;
    this.split = { leftTabId, rightTabId, ratio: clampRatio(ratio) };
    l.pane = 'left';
    r.pane = 'right';
    this.activeTabId = this.activeTabId === rightTabId ? rightTabId : leftTabId;
    for (const t of this.visibleTabs()) this.ensureAwake(t);
    this.layout();
    this.changed();
  }

  /** Splits the active tab with a neighbour or a new tab. */
  splitActive(url?: string): void {
    const active = this.activeTab;
    if (!active) return;
    if (this.split) {
      this.closeSplit();
      return;
    }
    let other: Tab;
    if (url) other = this.openTab(url, { background: true, afterActive: true, source: 'link' });
    else {
      const idx = this.tabs.indexOf(active);
      other = this.tabs[idx + 1] ?? this.tabs[idx - 1] ?? this.openTab(NEW_TAB_URL, { background: true, afterActive: true });
    }
    this.setSplit(active.id, other.id);
  }

  closeSplit(): void {
    for (const t of this.tabs) t.pane = undefined;
    this.split = null;
    this.layout();
    this.changed();
  }

  setSplitRatio(ratio: number): void {
    if (!this.split) return;
    this.split.ratio = clampRatio(ratio);
    this.layout();
    this.changed();
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  setContentRect(rect: Rect): void {
    this.contentRect = rect;
    this.layout();
  }

  /** While a UI popover is open, views are hidden; we return snapshots so the UI can paint them. */
  async setOverlay(open: boolean): Promise<{ rect: Rect; dataUrl: string }[]> {
    const shots: { rect: Rect; dataUrl: string }[] = [];
    if (open && !this.overlay) {
      for (const t of this.visibleTabs()) {
        const wc = t.wc;
        if (!wc || !t.view || t.crashed || t.error) continue;
        try {
          const img = await wc.capturePage();
          const b = t.view.getBounds();
          // Relative to the content area the UI reported.
          shots.push({ rect: { x: b.x - this.contentRect.x, y: b.y - this.contentRect.y, width: b.width, height: b.height }, dataUrl: img.toDataURL() });
        } catch {
          /* fall back to an empty area */
        }
      }
    }
    this.overlay = open;
    this.layout();
    return shots;
  }

  layout(): void {
    if (this.win.isDestroyed()) return;
    const visible = new Set(this.visibleTabs());
    const r = this.contentRect;
    const rects = new Map<Tab, Rect>();
    if (this.split && visible.size === 2) {
      const left = this.tabs.find((t) => t.id === this.split!.leftTabId)!;
      const right = this.tabs.find((t) => t.id === this.split!.rightTabId)!;
      const lw = Math.round((r.width - DIVIDER) * this.split.ratio);
      rects.set(left, { x: r.x, y: r.y, width: lw, height: r.height });
      rects.set(right, { x: r.x + lw + DIVIDER, y: r.y, width: Math.max(0, r.width - lw - DIVIDER), height: r.height });
    } else {
      for (const t of visible) rects.set(t, r);
    }
    for (const t of this.tabs) {
      if (!t.view) continue;
      const rect = rects.get(t);
      const show = !!rect && !this.overlay && !t.crashed && !t.error && rect.width > 0 && rect.height > 0;
      if (rect) t.view.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
      t.view.setVisible(show);
    }
  }

  // ---------------------------------------------------------------------------
  // State and persistence
  // ---------------------------------------------------------------------------

  changed(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.pushState();
    }, 16);
    this.schedulePersist();
  }

  pushState(): void {
    if (!this.uiReady || this.win.isDestroyed()) return;
    this.send('state', this.state());
    const active = this.activeTab;
    const title = active ? `${active.title || 'New Tab'} - AETHER` : 'AETHER';
    if (this.win.getTitle() !== title) this.win.setTitle(title);
  }

  state(): WindowState {
    const profiles = this.shell.profileSummaries();
    const profile = profiles.find((p) => p.id === this.profileId) ?? profiles[0];
    const ws = this.workspaceId ? this.shell.store.getWorkspace(this.workspaceId) : null;
    const active = this.activeTab;
    return {
      windowId: this.id,
      platform: process.platform,
      isPrivate: this.isPrivate,
      profile,
      profiles,
      workspace: ws ? { id: ws.id, name: ws.name, color: ws.color } : null,
      workspaces: this.shell.workspaceSummaries(this.profileId),
      tabs: this.tabs.map((t) => t.state()),
      groups: [...this.groups.values()].map((g) => ({ ...g })),
      activeTabId: this.activeTabId,
      split: this.split,
      bookmarked: !!(active && !this.isPrivate && this.shell.store.findBookmarkByUrl(this.profileId, active.url)),
      bookmarksBar: this.shell.bookmarksBarVisible(),
      bookmarksRev: this.shell.bookmarksRev,
      loginPrompt: this.loginOffer && this.tabs.some((t) => t.id === this.loginOffer!.tabId) ? { tabId: this.loginOffer.tabId, site: this.loginOffer.site, username: this.loginOffer.username, update: this.loginOffer.update } : null,
      savedLogins: active && !this.isPrivate ? this.shell.passwords.countForPage(this.profileId, active.url) : 0,
      sleepAfterMinutes: this.shell.sleepAfterMinutes(),
      themeId: this.shell.themeId(),
      theme: this.shell.theme(),
    };
  }

  snapshot(state: 'open' | 'saved'): Omit<WindowSession, 'updatedAt'> {
    const normal = this.win.isDestroyed() ? null : this.win.getNormalBounds();
    const leftIdx = this.split ? this.tabs.findIndex((t) => t.id === this.split!.leftTabId) : -1;
    const rightIdx = this.split ? this.tabs.findIndex((t) => t.id === this.split!.rightTabId) : -1;
    return {
      id: this.sessionId,
      profileId: this.profileId,
      workspaceId: this.workspaceId,
      state,
      title: this.activeTab?.title || 'Window',
      bounds: normal,
      maximized: !this.win.isDestroyed() && this.win.isMaximized(),
      tabs: this.tabs.map((t) => this.savedOf(t)),
      activeIndex: Math.max(0, this.tabs.findIndex((t) => t.id === this.activeTabId)),
      split: this.split && leftIdx >= 0 && rightIdx >= 0 ? { left: leftIdx, right: rightIdx, ratio: this.split.ratio } : null,
    };
  }

  schedulePersist(): void {
    if (this.isPrivate || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 1500);
  }

  /** Crash-safe checkpoint: the window is restorable even if the app dies. */
  persistNow(state: 'open' | 'saved' = 'open'): void {
    if (this.isPrivate || this.closing) return;
    try {
      const snap = this.snapshot(state);
      this.shell.store.saveWindowSession(snap);
      if (this.workspaceId) this.shell.store.updateWorkspace(this.workspaceId, { tabs: snap.tabs, activeIndex: snap.activeIndex });
    } catch (err) {
      console.error('[window] persist failed', err);
    }
  }

  async captureScrollPositions(all = false): Promise<void> {
    const targets = all ? this.tabs : this.visibleTabs();
    await Promise.all(targets.map((t) => t.captureScroll()));
  }

  // ---------------------------------------------------------------------------
  // Workspaces
  // ---------------------------------------------------------------------------

  /** Replaces this window's tabs with a workspace's tabs, saving the current context first. */
  async switchWorkspace(workspaceId: string | null): Promise<void> {
    if (workspaceId === this.workspaceId) return;
    await this.captureScrollPositions(true);
    this.persistNow();
    const target = workspaceId ? this.shell.store.getWorkspace(workspaceId) : null;
    if (workspaceId && (!target || target.profileId !== this.profileId)) throw new Error('Workspace not found in this profile');
    // Tabs without a workspace are kept as a saved window so nothing is lost.
    if (!this.workspaceId && this.tabs.some((t) => t.url !== NEW_TAB_URL)) {
      this.shell.store.saveWindowSession({ ...this.snapshot('saved'), id: randomUUID(), title: `Unsorted tabs: ${this.activeTab?.title ?? ''}`.slice(0, 120) });
    }
    for (const t of this.tabs) {
      if (t.view) this.win.contentView.removeChildView(t.view);
      t.destroy();
    }
    this.split = null;
    this.groups.clear();
    this.workspaceId = workspaceId;
    const saved = target?.tabs.length ? target.tabs : [{ url: NEW_TAB_URL, title: 'New Tab' }];
    this.tabs = saved.map((s) => this.makeTab(s));
    const active = this.tabs[Math.min(target?.activeIndex ?? 0, this.tabs.length - 1)];
    this.activate(active.id);
    this.persistNow();
  }

  // ---------------------------------------------------------------------------
  // WebContents wiring
  // ---------------------------------------------------------------------------

  private attachWebContents(tab: Tab, wc: WebContents): void {
    this.shell.registerTabContents(wc.id, this, tab);
    const isVisible = () => this.visibleTabs().includes(tab);

    wc.on('before-input-event', (e, input) => {
      if (this.handleShortcut(input)) e.preventDefault();
    });
    wc.on('did-start-loading', () => this.changed());
    wc.on('did-stop-loading', () => this.changed());
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        tab.error = null;
        this.layout();
      }
    });
    wc.on('did-navigate', (_e, url) => {
      tab.url = url;
      tab.favicon = null;
      tab.error = null;
      if (!this.isPrivate) this.shell.store.recordVisit(this.profileId, url, wc.getTitle(), this.typedNavigation.has(tab) ? 'typed' : 'link');
      this.typedNavigation.delete(tab);
      this.changed();
      this.shell.modules.emit('tabNavigated', { ...this.tabContext(tab), inPage: false });
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      this.changed();
      this.shell.modules.emit('tabNavigated', { ...this.tabContext(tab), inPage: true });
    });
    wc.on('did-finish-load', () => {
      void tab.restoreScroll();
    });
    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 = ABORTED (user stop / superseded navigation).
      if (!isMainFrame || code === -3) return;
      tab.error = { code, description, url };
      tab.url = url || tab.url;
      this.layout();
      this.changed();
      this.shell.modules.emit('tabLoadFailed', { ...this.tabContext(tab), code, description, failedUrl: url });
    });
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      if (!this.isPrivate) this.shell.store.updateHistoryTitle(this.profileId, tab.url, title);
      this.changed();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      void this.shell.favicons.fetch(this.session, favicons).then((data) => {
        tab.favicon = data;
        this.changed();
      });
    });
    wc.on('audio-state-changed', (e) => {
      this.changed();
      this.shell.modules.emit('tabAudible', { ...this.tabContext(tab), audible: e.audible });
    });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      tab.crashed = true;
      this.layout();
      this.changed();
    });
    wc.on('unresponsive', () => {
      tab.unresponsive = true;
      this.changed();
    });
    wc.on('responsive', () => {
      tab.unresponsive = false;
      this.changed();
    });
    wc.on('zoom-changed', (_e, dir) => this.zoom(tab, dir === 'in' ? 1 : -1));
    wc.on('found-in-page', (_e, result) => {
      if (isVisible()) this.send('find-result', { tabId: tab.id, matches: result.matches, active: result.activeMatchOrdinal, final: result.finalUpdate });
    });
    wc.on('enter-html-full-screen', () => this.win.setFullScreen(true));
    wc.on('leave-html-full-screen', () => this.win.setFullScreen(false));
    wc.on('context-menu', (_e, params) => this.showContextMenu(tab, wc, params));

    // Top-level navigations initiated by the page.
    wc.on('will-navigate', (e, url) => {
      if (!this.shell.modules.hasInterceptors()) return;
      const req: NavigationRequest = { url, source: 'link', tab: this.tabContext(tab), profileId: this.profileId, workspaceId: this.workspaceId, isPrivate: this.isPrivate };
      e.preventDefault();
      void this.shell.modules.decide(req).then((d) => {
        if (d.action === 'allow') void wc.loadURL(url);
        else if (d.action === 'redirect') void wc.loadURL(d.url);
        else void wc.loadURL(`aether://blocked?url=${encodeURIComponent(url)}&reason=${encodeURIComponent(d.reason)}`);
      });
    });

    // Popups: real popups (OAuth sign-in) keep their opener; links open as tabs.
    wc.setWindowOpenHandler((details) => {
      const url = details.url;
      if (!/^(https?|aether):/i.test(url) && url !== 'about:blank') return { action: 'deny' };
      if (details.disposition === 'new-window' && details.features) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 520,
            height: 680,
            autoHideMenuBar: true,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, session: this.session },
          },
        };
      }
      this.openTab(url, { background: details.disposition === 'background-tab', afterActive: true, source: 'new-tab' });
      return { action: 'deny' };
    });
    wc.on('did-create-window', (child) => {
      child.webContents.on('before-input-event', (e, input) => {
        if (shortcutFor(input, process.platform === 'darwin') === 'Mod+W') {
          e.preventDefault();
          child.close();
        }
      });
      child.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) this.openTab(url, { afterActive: true, source: 'new-tab' });
        return { action: 'deny' };
      });
    });
  }

  private showContextMenu(tab: Tab, wc: WebContents, p: Electron.ContextMenuParams): void {
    const items: MenuItemConstructorOptions[] = [];
    const engine = this.shell.store.getProfile(this.profileId)?.searchEngine ?? 'google';
    if (p.misspelledWord) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) }, { type: 'separator' });
    }
    if (p.linkURL && /^(https?|aether):/i.test(p.linkURL)) {
      items.push(
        { label: 'Open link in new tab', click: () => this.openTab(p.linkURL, { background: true, afterActive: true, source: 'new-tab' }) },
        { label: 'Open link in split view', click: () => this.splitActive(p.linkURL) },
        { label: 'Open link in new window', click: () => this.shell.openWindow({ profileId: this.profileId, isPrivate: this.isPrivate, tabs: [{ url: p.linkURL, title: '' }] }) },
        ...(!this.isPrivate ? [{ label: 'Open link in private window', click: () => this.shell.openWindow({ profileId: this.profileId, isPrivate: true, tabs: [{ url: p.linkURL, title: '' }] }) }] : []),
        { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Open image in new tab', click: () => this.openTab(p.srcURL, { background: true, afterActive: true, source: 'new-tab' }) },
        { label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) },
        { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
        { type: 'separator' },
      );
    }
    const sel = p.selectionText.trim();
    const openQuery = (q: string) => {
      const r = resolveOmniboxInput(q, { engine });
      if (r.kind !== 'invalid') this.openTab(r.url, { afterActive: true, source: 'new-tab' });
    };
    if (sel) {
      const short = sel.length > 32 ? sel.slice(0, 32) + '…' : sel;
      items.push(
        { role: 'copy', label: 'Copy' },
        ...(() => {
          // Engineers select numbers and formulas: offer the answer right here.
          const calc = sel.length < 200 ? quickCalc(`=${sel}`) : null;
          return calc && 'text' in calc && calc.copy !== sel ? [{ label: `= ${calc.text}  (copy)`, click: () => clipboard.writeText(calc.copy) }] : [];
        })(),
        { label: `Search for “${short}”`, click: () => openQuery(sel) },
        { label: `Look up on Wikipedia`, click: () => openQuery(`!w ${sel}`) },
        { label: `Compute with WolframAlpha`, click: () => openQuery(`!wa ${sel}`) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' }, { type: 'separator' });
    if (!p.linkURL && !sel && !p.isEditable) {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Reader view', enabled: /^https?:/i.test(tab.url), click: () => void this.toggleReader(tab).catch(() => undefined) },
        { label: 'Save page as…', click: () => void this.savePage(wc) },
        { label: 'Print…', click: () => wc.print() },
        { label: 'Copy page address', click: () => clipboard.writeText(tab.url) },
        { type: 'separator' },
      );
    }
    items.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  private async savePage(wc: WebContents): Promise<void> {
    const { filePath, canceled } = await dialog.showSaveDialog(this.win, {
      defaultPath: `${(wc.getTitle() || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100)}.html`,
      filters: [{ name: 'Web page, complete', extensions: ['html'] }],
    });
    if (!canceled && filePath) await wc.savePage(filePath, 'HTMLComplete').catch(() => this.send('toast', { kind: 'error', text: 'Could not save the page.' }));
  }

  zoom(tab: Tab, dir: -1 | 0 | 1): void {
    const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
    let i = steps.findIndex((s) => Math.abs(s - tab.zoom) < 0.01);
    if (i === -1) i = steps.indexOf(1);
    tab.zoom = dir === 0 ? 1 : steps[Math.max(0, Math.min(steps.length - 1, i + dir))];
    tab.wc?.setZoomFactor(tab.zoom);
    this.changed();
  }

  async getPageContent(tab: Tab) {
    const wc = tab.wc;
    if (!wc) return null;
    try {
      return await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: PAGE_CONTENT_SCRIPT }]);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Shortcuts
  // ---------------------------------------------------------------------------

  handleShortcut(input: Input): boolean {
    const key = shortcutFor(input, process.platform === 'darwin');
    if (!key) return false;
    const tab = this.activeTab;
    const wc = tab?.wc;
    const byIndex = /^Mod\+([1-9])$/.exec(key);
    if (byIndex) {
      const n = Number(byIndex[1]);
      const target = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
      if (target) this.activate(target.id);
      return true;
    }
    switch (key) {
      case 'Mod+T':
        this.openTab(NEW_TAB_URL);
        return true;
      case 'Mod+W':
      case 'Mod+F4':
        if (tab) this.closeTab(tab.id);
        return true;
      case 'Mod+Shift+T':
        this.reopenClosedTab();
        return true;
      case 'Mod+N':
        this.shell.openWindow({ profileId: this.profileId });
        return true;
      case 'Mod+Shift+N':
        this.shell.openWindow({ profileId: this.profileId, isPrivate: true });
        return true;
      case 'Mod+Shift+W':
        this.win.close();
        return true;
      case 'Mod+L':
      case 'Alt+D':
      case 'F6':
        this.command('focus-address');
        return true;
      case 'Mod+K':
        this.command('command-palette');
        return true;
      case 'Mod+F':
        this.command('find');
        return true;
      case 'Mod+H':
        this.command('panel:history');
        return true;
      case 'Mod+J':
        this.command('panel:downloads');
        return true;
      case 'Mod+Shift+O':
        this.command('panel:bookmarks');
        return true;
      case 'Mod+Shift+K':
        this.command('panel:notes');
        return true;
      case 'Mod+Alt+R':
        if (tab) void this.toggleReader(tab).catch(() => undefined);
        return true;
      case 'Mod+Shift+B':
        this.shell.toggleBookmarksBar();
        return true;
      case 'Mod+Shift+L':
        this.command('panel:passwords');
        return true;
      case 'Mod+B':
        this.command('toggle-sidebar');
        return true;
      case 'Mod+D':
        if (tab && !this.isPrivate) this.shell.toggleBookmark(this, tab);
        return true;
      case 'Mod+\\':
        this.splitActive();
        return true;
      case 'Mod+R':
      case 'F5':
        wc?.reload();
        if (tab?.crashed || tab?.error) this.reloadTab(tab);
        return true;
      case 'Mod+Shift+R':
      case 'Mod+F5':
        wc?.reloadIgnoringCache();
        return true;
      case 'Alt+ArrowLeft':
        wc?.navigationHistory.goBack();
        return true;
      case 'Alt+ArrowRight':
        wc?.navigationHistory.goForward();
        return true;
      case 'Mod+Tab':
      case 'Mod+PageDown':
      case 'Mod+Shift+Tab':
      case 'Mod+PageUp': {
        if (!tab || this.tabs.length < 2) return true;
        const dir = key.includes('Shift') || key.endsWith('PageUp') ? -1 : 1;
        const i = (this.tabs.indexOf(tab) + dir + this.tabs.length) % this.tabs.length;
        this.activate(this.tabs[i].id);
        return true;
      }
      case 'Mod+=':
      case 'Mod+Shift+=':
        if (tab) this.zoom(tab, 1);
        return true;
      case 'Mod+-':
        if (tab) this.zoom(tab, -1);
        return true;
      case 'Mod+0':
        if (tab) this.zoom(tab, 0);
        return true;
      case 'Mod+P':
        wc?.print();
        return true;
      case 'Mod+S':
        if (wc) void this.savePage(wc);
        return true;
      case 'F11':
        this.win.setFullScreen(!this.win.isFullScreen());
        return true;
      case 'F12':
      case 'Mod+Shift+I':
        wc?.toggleDevTools();
        return true;
      case 'Mod+U':
        if (tab && /^https?:/.test(tab.url)) this.openTab(`view-source:${tab.url}`, { afterActive: true });
        return true;
      default:
        return false;
    }
  }

  reloadTab(tab: Tab): void {
    if (tab.crashed || !tab.wc) {
      if (tab.view) this.win.contentView.removeChildView(tab.view);
      tab.destroy();
      tab.crashed = false;
      tab.error = null;
      this.ensureAwake(tab);
      this.layout();
    } else if (tab.error) {
      const url = tab.error.url || tab.url;
      tab.error = null;
      void tab.wc.loadURL(url).catch(() => {});
    } else {
      tab.wc.reload();
    }
    this.changed();
  }

  // ---------------------------------------------------------------------------
  // Window lifecycle
  // ---------------------------------------------------------------------------

  uiDidLoad(): void {
    this.uiReady = true;
    this.pushState();
  }

  private wireWindow(): void {
    const ui = this.webContents;
    ui.on('before-input-event', (e, input) => {
      if (this.handleShortcut(input)) e.preventDefault();
    });
    // The UI must never navigate away or open windows.
    ui.on('will-navigate', (e) => e.preventDefault());
    ui.setWindowOpenHandler(() => ({ action: 'deny' }));
    ui.on('render-process-gone', (_e, d) => {
      console.error('[window] UI renderer gone, reloading', d.reason);
      this.uiReady = false;
      if (!this.win.isDestroyed()) setTimeout(() => void this.win.loadURL(this.shell.uiUrl), 250);
    });

    this.win.once('ready-to-show', () => this.win.show());
    this.win.on('focus', () => {
      this.shell.lastFocused = this;
      this.shell.modules.emit('windowFocusChanged', { windowId: this.id, focused: true, profileId: this.profileId, isPrivate: this.isPrivate });
    });
    this.win.on('blur', () => this.shell.modules.emit('windowFocusChanged', { windowId: this.id, focused: false, profileId: this.profileId, isPrivate: this.isPrivate }));
    this.win.on('minimize', () => this.shell.modules.emit('windowMinimized', { windowId: this.id, minimized: true }));
    this.win.on('restore', () => this.shell.modules.emit('windowMinimized', { windowId: this.id, minimized: false }));
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize'] as const) this.win.on(ev as 'resize', () => this.schedulePersist());

    this.win.on('close', (e) => {
      if (this.closeConfirmed || this.shell.quitting) return;
      e.preventDefault();
      void this.confirmClose();
    });
    this.win.on('closed', () => {
      this.closing = true;
      if (this.stateTimer) clearTimeout(this.stateTimer);
      if (this.persistTimer) clearTimeout(this.persistTimer);
      for (const t of this.tabs) t.destroy();
      if (this.isPrivate) void this.shell.sessions.disposePrivate(this.session);
      this.shell.windowClosed(this);
      this.shell.modules.emit('windowClosed', { windowId: this.id });
    });
  }

  /** Re-applies the theme to native chrome and built-in pages. */
  onTheme = () => {
    if (this.win.isDestroyed()) return;
    const theme = this.shell.theme();
    this.win.setBackgroundColor(theme.tokens.chrome);
    if (process.platform !== 'darwin') {
      try {
        this.win.setTitleBarOverlay({ color: '#00000000', symbolColor: theme.tokens.fg, height: TITLEBAR_HEIGHT });
      } catch {
        /* not supported on this platform */
      }
    }
    for (const t of this.tabs) if (t.wc && t.url.startsWith('aether://newtab')) t.wc.reload();
    this.changed();
  };

  /**
   * Asks whether to keep this window's tabs for next time, honouring the
   * profile's remembered choice. Private windows and empty windows close at once.
   */
  async confirmClose(): Promise<void> {
    const trivial = this.tabs.every((t) => t.url === NEW_TAB_URL);
    const profile = this.shell.store.getProfile(this.profileId);
    let behavior = profile?.closeBehavior ?? 'ask';
    if (this.isPrivate || trivial) behavior = 'discard';
    if (behavior === 'ask') {
      const { response, checkboxChecked } = await dialog.showMessageBox(this.win, {
        type: 'question',
        title: 'Close window',
        message: `Keep this window for next time?`,
        detail: `${this.tabs.length} tab${this.tabs.length === 1 ? '' : 's'} in “${profile?.name ?? 'this profile'}”${this.workspaceId ? ' (the workspace is saved either way)' : ''}. Kept windows reopen with their tabs and reading positions when you start AETHER or open this profile.`,
        buttons: ['Keep and close', 'Close without keeping', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        checkboxLabel: 'Remember my choice for this profile',
        noLink: true,
      });
      if (response === 2) return;
      behavior = response === 0 ? 'save' : 'discard';
      if (checkboxChecked) this.shell.store.updateProfile(this.profileId, { closeBehavior: behavior });
    }
    await this.captureScrollPositions(true).catch(() => {});
    if (!this.isPrivate) {
      if (behavior === 'save') this.persistNow('saved');
      else {
        if (this.workspaceId) this.persistNow();
        this.shell.store.deleteWindowSession(this.sessionId);
      }
    }
    this.closing = true;
    this.closeConfirmed = true;
    if (!this.win.isDestroyed()) this.win.close();
  }
}

function clampRatio(r: number): number {
  return Math.max(0.15, Math.min(0.85, Number.isFinite(r) ? r : 0.5));
}

/** Keeps restored windows on a visible display. */
function sanitizeBounds(b: Bounds | null): Partial<Bounds> {
  const fallback = { width: 1280, height: 820 };
  if (!b) return fallback;
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const a = d.workArea;
    return b.x + 100 < a.x + a.width && b.x + b.width - 100 > a.x && b.y >= a.y - 10 && b.y + 40 < a.y + a.height;
  });
  if (!visible) return { width: Math.max(480, b.width), height: Math.max(360, b.height) };
  return { x: b.x, y: b.y, width: Math.max(480, b.width), height: Math.max(360, b.height) };
}

export { NEW_TAB_URL };
