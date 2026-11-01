import type { ResourceType } from '@aether/web-request-hub';

export interface BlockedRequest {
  url: string;
  host: string;
  resourceType: ResourceType;
  /** The filter rule text that matched, when the engine provides it. */
  filter?: string;
  at: number;
  kind: 'blocked' | 'redirected';
}

export interface TabStats {
  pageUrl: string;
  blocked: number;
  cookiesStripped: number;
  upgradedToHttps: boolean;
  trackingParamsRemoved: boolean;
  recent: BlockedRequest[];
}

const MAX_RECENT = 200;

/**
 * Per-tab counters for the privacy panel. Counts come only from actual filtering
 * decisions made in the request handler, so the indicator never overstates.
 */
export class PrivacyStats {
  private readonly tabs = new Map<number, TabStats>();
  private totalBlocked = 0;
  private readonly listeners = new Set<(webContentsId: number, stats: TabStats) => void>();

  pageStarted(webContentsId: number, pageUrl: string, flags: { upgradedToHttps?: boolean; trackingParamsRemoved?: boolean } = {}): void {
    this.tabs.set(webContentsId, {
      pageUrl,
      blocked: 0,
      cookiesStripped: 0,
      upgradedToHttps: flags.upgradedToHttps ?? false,
      trackingParamsRemoved: flags.trackingParamsRemoved ?? false,
      recent: [],
    });
    this.emit(webContentsId);
  }

  /** Marks the pending main-frame navigation; carried over by pageStarted. */
  recordBlocked(webContentsId: number | undefined, entry: BlockedRequest): void {
    this.totalBlocked++;
    if (webContentsId === undefined) return;
    const tab = this.ensure(webContentsId);
    tab.blocked++;
    tab.recent.push(entry);
    if (tab.recent.length > MAX_RECENT) tab.recent.shift();
    this.emit(webContentsId);
  }

  recordCookieStripped(webContentsId: number | undefined): void {
    if (webContentsId === undefined) return;
    this.ensure(webContentsId).cookiesStripped++;
  }

  forTab(webContentsId: number): TabStats | undefined {
    const t = this.tabs.get(webContentsId);
    return t ? { ...t, recent: [...t.recent] } : undefined;
  }

  /** Blocked requests since the app started, across all tabs in this profile. */
  total(): number {
    return this.totalBlocked;
  }

  tabClosed(webContentsId: number): void {
    this.tabs.delete(webContentsId);
  }

  onChange(listener: (webContentsId: number, stats: TabStats) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private ensure(id: number): TabStats {
    let t = this.tabs.get(id);
    if (!t) {
      t = { pageUrl: '', blocked: 0, cookiesStripped: 0, upgradedToHttps: false, trackingParamsRemoved: false, recent: [] };
      this.tabs.set(id, t);
    }
    return t;
  }

  private emit(id: number): void {
    const t = this.tabs.get(id);
    if (!t) return;
    for (const l of this.listeners) l(id, t);
  }
}
