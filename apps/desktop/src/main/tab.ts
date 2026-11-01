import { WebContentsView, type Session, type WebContents } from 'electron';
import type { SavedTab } from '@aether/storage';
import type { TabState } from '../shared/types';

let nextTabId = 1;

/** Script run in an isolated world (never the page's own world). */
const ISOLATED_WORLD = 1001;

export interface TabHooks {
  /** Called on any state change that should reach the UI. */
  changed(tab: Tab): void;
  /** Wires per-WebContents handlers (navigation, popups, keyboard...). */
  attach(tab: Tab, wc: WebContents): void;
}

/**
 * One browser tab. Owns at most one WebContentsView; a "sleeping" tab has
 * none and only remembers its URL, title and reading position. Restored tabs
 * start asleep so a 40-tab session costs almost nothing until used.
 */
export class Tab {
  readonly id = nextTabId++;
  view: WebContentsView | null = null;
  url: string;
  title: string;
  favicon: string | null = null;
  pinned = false;
  groupId: string | null = null;
  muted = false;
  crashed = false;
  unresponsive = false;
  error: TabState['error'] = null;
  lastActiveAt = Date.now();
  /** Scroll offset to restore once the next load finishes. */
  pendingScrollY: number | null = null;
  scrollY = 0;
  zoom = 1;
  pane: 'left' | 'right' | undefined;
  /** Set while a navigation is waiting on interceptors: the view is created but not loaded. */
  holdLoad = false;

  constructor(
    private session: Session,
    private hooks: TabHooks,
    init: { url: string; title?: string; scrollY?: number; pinned?: boolean },
  ) {
    this.url = init.url;
    this.title = init.title ?? '';
    this.pinned = !!init.pinned;
    if (init.scrollY) {
      this.scrollY = init.scrollY;
      this.pendingScrollY = init.scrollY;
    }
  }

  get wc(): WebContents | null {
    return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents : null;
  }

  get sleeping(): boolean {
    return this.view === null;
  }

  /** Creates the view if needed. Returns true if it had to be created. */
  wake(): boolean {
    if (this.view) return false;
    const view = new WebContentsView({
      webPreferences: {
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: true,
        // Enables Chromium's built-in PDF viewer (datasheets, papers).
        plugins: true,
        safeDialogs: true,
        autoplayPolicy: 'document-user-activation-required',
      },
    });
    view.setBackgroundColor('#00000000');
    this.view = view;
    this.crashed = false;
    this.unresponsive = false;
    this.hooks.attach(this, view.webContents);
    if (this.zoom !== 1) view.webContents.setZoomFactor(this.zoom);
    view.webContents.setAudioMuted(this.muted);
    if (this.holdLoad) return true;
    void view.webContents.loadURL(this.url).catch(() => {
      /* load errors surface through did-fail-load */
    });
    return true;
  }

  /** Discards the renderer to free memory, keeping enough to restore. */
  async sleep(): Promise<void> {
    const wc = this.wc;
    if (!wc) return;
    await this.captureScroll();
    const view = this.view!;
    this.view = null;
    try {
      view.webContents.close({ waitForBeforeUnload: false });
    } catch {
      /* already gone */
    }
    this.pendingScrollY = this.scrollY || null;
    this.hooks.changed(this);
  }

  destroy(): void {
    const view = this.view;
    this.view = null;
    if (view && !view.webContents.isDestroyed()) {
      try {
        view.webContents.close();
      } catch {
        /* ignore */
      }
    }
  }

  navigate(url: string): void {
    this.url = url;
    this.error = null;
    this.crashed = false;
    this.pendingScrollY = null;
    this.holdLoad = false;
    if (!this.wc) {
      this.wake();
    } else {
      void this.wc.loadURL(url).catch(() => {});
    }
    this.hooks.changed(this);
  }

  /** Reads the reading position from an isolated world (read-only). */
  async captureScroll(): Promise<number> {
    const wc = this.wc;
    if (!wc || wc.isLoading() || this.crashed) return this.scrollY;
    try {
      const y = await Promise.race([
        wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: 'Math.round(window.scrollY)' }]),
        new Promise((resolve) => setTimeout(() => resolve(null), 300)),
      ]);
      if (typeof y === 'number' && Number.isFinite(y)) this.scrollY = y;
    } catch {
      /* page may be mid-navigation */
    }
    return this.scrollY;
  }

  async restoreScroll(): Promise<void> {
    const y = this.pendingScrollY;
    const wc = this.wc;
    if (!y || !wc) return;
    this.pendingScrollY = null;
    try {
      await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: `window.scrollTo(0, ${Math.max(0, Math.floor(y))})` }]);
    } catch {
      /* ignore */
    }
  }

  toSaved(): SavedTab {
    const saved: SavedTab = { url: this.url, title: this.title };
    if (this.scrollY > 0) saved.scrollY = this.scrollY;
    if (this.pinned) saved.pinned = true;
    if (this.pane) saved.pane = this.pane;
    return saved;
  }

  state(): TabState {
    const wc = this.wc;
    let secure = false;
    try {
      const u = new URL(this.url);
      secure = u.protocol === 'https:' || u.protocol === 'aether:';
    } catch {
      /* ignore */
    }
    return {
      id: this.id,
      url: this.url,
      title: this.title || this.url,
      favicon: this.favicon,
      loading: wc ? wc.isLoading() : false,
      canGoBack: wc ? wc.navigationHistory.canGoBack() : false,
      canGoForward: wc ? wc.navigationHistory.canGoForward() : false,
      audible: wc ? wc.isCurrentlyAudible() : false,
      muted: this.muted,
      pinned: this.pinned,
      groupId: this.groupId,
      sleeping: this.sleeping,
      crashed: this.crashed,
      unresponsive: this.unresponsive,
      zoom: this.zoom,
      error: this.error,
      secure,
    };
  }
}

/** Collected by the research module through host.tabs.getPageContent. */
export const PAGE_CONTENT_SCRIPT = `(() => {
  const meta = {};
  for (const m of document.querySelectorAll('meta[name], meta[property]')) {
    const k = (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase();
    const v = m.getAttribute('content');
    if (!k || v == null) continue;
    (meta[k] = meta[k] || []).push(v.slice(0, 2000));
  }
  const doiRe = /\\b10\\.\\d{4,9}\\/[^\\s"<>]+/g;
  const dois = new Set();
  for (const k of ['citation_doi', 'dc.identifier', 'prism.doi']) for (const v of meta[k] || []) for (const d of v.match(doiRe) || []) dois.add(d);
  for (const d of location.href.match(doiRe) || []) dois.add(decodeURIComponent(d));
  const text = (document.body ? document.body.innerText : '').slice(0, 300000);
  return { url: location.href, title: document.title, text, meta, dois: [...dois], selection: String(getSelection() || '').slice(0, 20000) };
})()`;

export { ISOLATED_WORLD };
