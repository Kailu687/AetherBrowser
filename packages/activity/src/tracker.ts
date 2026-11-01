import { getDomain, getHostname } from 'tldts';
import { categorize } from './categories.js';
import type { ActivityStore } from './store.js';
import { defaultActivitySettings, type ActivityKind, type ActivitySettings, type Budget, type Category } from './types.js';

export interface TabInfo {
  tabId: number;
  windowId: number;
  url: string;
  profileId: string;
  workspaceId?: string | null;
  isPrivate: boolean;
}

export interface BudgetReminder {
  budget: Budget;
  usedMinutes: number;
  /** 80 or 100. */
  percent: number;
}

export interface ActivityTrackerOptions {
  store: ActivityStore;
  settings?: ActivitySettings;
  /** Seconds since the last OS-level keyboard/mouse input (Electron powerMonitor.getSystemIdleTime). */
  getIdleSeconds(): number;
  now?: () => number;
  /** Open segments are written at least this often so a crash loses little. Default 60 s. */
  checkpointMs?: number;
  onBudgetReminder?(reminder: BudgetReminder): void;
}

interface WindowState {
  focused: boolean;
  minimized: boolean;
  activeTabId?: number;
}

interface TabState extends TabInfo {
  audible: boolean;
}

interface Target {
  key: string;
  tabId: number;
  kind: ActivityKind;
  domain: string;
  category: Category;
  profileId: string;
  workspaceId: string | null;
}

interface OpenSegment extends Target {
  start: number;
  persistedId?: number;
  persistedEnd?: number;
}

const MIN_SEGMENT_MS = 1000;

/**
 * Turns browser state events into time segments. All work happens on events and on
 * tick(); there is no polling of page content. Call tick() every ~15 s and flush()
 * before quitting.
 */
export class ActivityTracker {
  private settings: ActivitySettings;
  private readonly windows = new Map<number, WindowState>();
  private readonly tabs = new Map<number, TabState>();
  private readonly open = new Map<string, OpenSegment>();
  private idleSince: number | undefined;
  private lastEvaluatedAt: number;
  private lastCheckpointAt: number;
  private suspended = false;
  private readonly now: () => number;
  private readonly checkpointMs: number;
  private budgetDay = '';
  private readonly budgetUsage = new Map<string, number>();
  private readonly budgetFired = new Set<string>();
  private lastRetentionRun = 0;

  constructor(private readonly options: ActivityTrackerOptions) {
    this.now = options.now ?? Date.now;
    this.settings = options.settings ?? defaultActivitySettings();
    this.checkpointMs = options.checkpointMs ?? 60_000;
    this.lastEvaluatedAt = this.now();
    this.lastCheckpointAt = this.lastEvaluatedAt;
  }

  getSettings(): ActivitySettings {
    return this.settings;
  }

  setSettings(settings: ActivitySettings): void {
    this.reevaluate(this.now());
    this.settings = settings;
    this.reevaluate(this.now());
  }

  pause(minutes?: number): void {
    this.setSettings({ ...this.settings, pausedUntil: minutes ? this.now() + minutes * 60_000 : Number.MAX_SAFE_INTEGER });
  }

  resume(): void {
    this.setSettings({ ...this.settings, pausedUntil: null });
  }

  isRecording(): boolean {
    const s = this.settings;
    return s.enabled && !(s.pausedUntil && s.pausedUntil > this.now()) && !this.suspended;
  }

  // ---- events from the shell ------------------------------------------------

  windowFocusChanged(e: { windowId: number; focused: boolean }): void {
    const at = this.now();
    this.reevaluate(at);
    if (e.focused) {
      for (const w of this.windows.values()) w.focused = false;
      this.userActed(at);
    }
    this.win(e.windowId).focused = e.focused;
    this.reevaluate(at);
  }

  windowMinimized(e: { windowId: number; minimized: boolean }): void {
    this.reevaluate(this.now());
    this.win(e.windowId).minimized = e.minimized;
    this.reevaluate(this.now());
  }

  windowClosed(e: { windowId: number }): void {
    this.reevaluate(this.now());
    this.windows.delete(e.windowId);
    for (const [id, t] of this.tabs) if (t.windowId === e.windowId) this.tabs.delete(id);
    this.reevaluate(this.now());
  }

  activeTabChanged(tab: TabInfo): void {
    const at = this.now();
    this.reevaluate(at);
    this.upsertTab(tab);
    this.win(tab.windowId).activeTabId = tab.tabId;
    this.userActed(at);
    this.reevaluate(at);
  }

  tabNavigated(tab: TabInfo): void {
    this.reevaluate(this.now());
    this.upsertTab(tab);
    this.reevaluate(this.now());
  }

  tabAudible(e: { tabId: number; audible: boolean }): void {
    const t = this.tabs.get(e.tabId);
    if (!t) return;
    this.reevaluate(this.now());
    t.audible = e.audible;
    this.reevaluate(this.now());
  }

  tabClosed(e: { tabId: number }): void {
    this.reevaluate(this.now());
    this.tabs.delete(e.tabId);
    for (const w of this.windows.values()) if (w.activeTabId === e.tabId) w.activeTabId = undefined;
    this.reevaluate(this.now());
  }

  /** Screen locked, system suspended or app hidden to tray: stop counting immediately. */
  systemSuspended(): void {
    this.reevaluate(this.now());
    this.suspended = true;
    this.reevaluate(this.now());
  }

  systemResumed(): void {
    this.suspended = false;
    this.userActed(this.now());
    this.reevaluate(this.now());
  }

  /** Call periodically (every 10–30 s). Detects idle transitions with backdated timestamps. */
  tick(): void {
    const now = this.now();
    const idleSeconds = Math.max(0, this.options.getIdleSeconds());
    const threshold = this.settings.idleThresholdSeconds;
    if (idleSeconds >= threshold) {
      // Input stopped idleSeconds ago, so time since then was not active: rewrite it.
      const since = now - idleSeconds * 1000;
      if (this.idleSince === undefined || since > this.idleSince + 1000) {
        this.idleSince = since;
        this.retroactively(since, (seg) => seg.kind === 'active');
      }
      const passiveEnd = this.idleSince + this.settings.maxPassiveMinutes * 60_000;
      if (passiveEnd <= now) this.retroactively(passiveEnd, (seg) => seg.kind === 'passive');
    } else if (this.idleSince !== undefined) {
      // Input resumed idleSeconds ago: active time starts then, not at this tick.
      const back = Math.max(now - idleSeconds * 1000, this.idleSince);
      this.idleSince = undefined;
      this.retroactively(back, (seg) => seg.kind === 'passive');
    }
    this.reevaluate(now);
    if (now - this.lastCheckpointAt >= this.checkpointMs) this.checkpoint(now);
    if (now - this.lastRetentionRun > 6 * 3600_000) this.applyRetention();
  }

  /** Writes all open segments; call before quit. Tracking continues afterwards. */
  flush(): void {
    const now = this.now();
    this.reevaluate(now);
    this.checkpoint(now);
  }

  applyRetention(): void {
    this.lastRetentionRun = this.now();
    if (this.settings.retentionDays > 0) this.options.store.deleteBefore(this.now() - this.settings.retentionDays * 86_400_000);
  }

  /** What is being counted right now (for a status indicator). */
  currentTargets(): { kind: ActivityKind; domain: string; category: Category }[] {
    return [...this.open.values()].map(({ kind, domain, category }) => ({ kind, domain, category }));
  }

  // ---- internals ---------------------------------------------------------------

  private userActed(at: number): void {
    if (this.idleSince !== undefined && at >= this.idleSince) this.idleSince = undefined;
  }

  private win(id: number): WindowState {
    let w = this.windows.get(id);
    if (!w) this.windows.set(id, (w = { focused: false, minimized: false }));
    return w;
  }

  private upsertTab(tab: TabInfo): void {
    const prev = this.tabs.get(tab.tabId);
    this.tabs.set(tab.tabId, { ...tab, workspaceId: tab.workspaceId ?? null, audible: prev?.audible ?? false });
  }

  private desiredTargets(at: number): Map<string, Target> {
    const out = new Map<string, Target>();
    if (!this.isRecordingAt(at)) return out;
    const idle = this.idleSince !== undefined && at >= this.idleSince;
    const passiveOk = !idle || at < this.idleSince! + this.settings.maxPassiveMinutes * 60_000;
    const focused = [...this.windows.values()].find((w) => w.focused && !w.minimized);
    const front = focused?.activeTabId !== undefined ? this.tabs.get(focused.activeTabId) : undefined;
    if (front) {
      const kind: ActivityKind | undefined = !idle ? 'active' : front.audible ? 'media' : passiveOk ? 'passive' : undefined;
      if (kind) this.addTarget(out, front, kind);
    }
    for (const t of this.tabs.values()) if (t.audible && t !== front) this.addTarget(out, t, 'media');
    return out;
  }

  private isRecordingAt(at: number): boolean {
    const s = this.settings;
    return s.enabled && !(s.pausedUntil && s.pausedUntil > at) && !this.suspended;
  }

  private addTarget(out: Map<string, Target>, tab: TabState, kind: ActivityKind): void {
    if (tab.isPrivate) return;
    if (this.settings.excludedProfiles.includes(tab.profileId)) return;
    if (!/^https?:\/\//i.test(tab.url)) return;
    const host = (getHostname(tab.url) ?? '').toLowerCase();
    if (!host) return;
    if (this.settings.excludedDomains.some((d) => host === d || host.endsWith('.' + d))) return;
    const domain = (getDomain(tab.url) ?? host).toLowerCase();
    const category = categorize(tab.url, this.settings.categoryOverrides);
    const workspaceId = tab.workspaceId ?? null;
    const key = `${tab.tabId}|${kind}|${domain}|${category}|${tab.profileId}|${workspaceId}`;
    out.set(key, { key, tabId: tab.tabId, kind, domain, category, profileId: tab.profileId, workspaceId });
  }

  private reevaluate(at: number): void {
    if (at < this.lastEvaluatedAt) at = this.lastEvaluatedAt;
    this.lastEvaluatedAt = at;
    const desired = this.desiredTargets(at);
    for (const [key, seg] of this.open) {
      if (!desired.has(key)) {
        this.close(seg, at);
        this.open.delete(key);
      }
    }
    for (const [key, t] of desired) if (!this.open.has(key)) this.open.set(key, { ...t, start: at });
  }

  private close(seg: OpenSegment, end: number): void {
    if (seg.persistedId !== undefined && seg.persistedEnd !== undefined && end < seg.persistedEnd) {
      // A checkpoint already wrote past this point; shrink the row.
      if (end - seg.start < MIN_SEGMENT_MS) this.options.store.updateSegmentEnd(seg.persistedId, seg.start);
      else this.options.store.updateSegmentEnd(seg.persistedId, end);
      seg.persistedEnd = end;
      return;
    }
    this.persist(seg, end);
  }

  /**
   * Corrects the recent past after an idle transition is noticed: closes the matching
   * open segments at `at` and opens whatever should have been counted from then on.
   */
  private retroactively(at: number, shouldClose: (seg: OpenSegment) => boolean): void {
    const desired = this.desiredTargets(at);
    for (const [key, seg] of this.open) {
      if (shouldClose(seg) && !desired.has(key)) {
        this.close(seg, Math.max(seg.start, at));
        this.open.delete(key);
      }
    }
    for (const [key, t] of desired) if (!this.open.has(key)) this.open.set(key, { ...t, start: at });
  }

  private checkpoint(at: number): void {
    this.lastCheckpointAt = at;
    for (const seg of this.open.values()) this.persist(seg, at);
  }

  private persist(seg: OpenSegment, end: number): void {
    const prevEnd = seg.persistedEnd ?? seg.start;
    if (end <= prevEnd) return;
    if (seg.persistedId === undefined) {
      if (end - seg.start < MIN_SEGMENT_MS) return;
      seg.persistedId = this.options.store.insertSegment({
        start: seg.start,
        end,
        kind: seg.kind,
        domain: seg.domain,
        category: seg.category,
        profileId: seg.profileId,
        workspaceId: seg.workspaceId,
      });
    } else {
      this.options.store.updateSegmentEnd(seg.persistedId, end);
    }
    seg.persistedEnd = end;
    if (seg.kind === 'active') this.countBudget(seg, end - prevEnd, end);
  }

  private countBudget(seg: OpenSegment, deltaMs: number, at: number): void {
    if (!this.settings.budgets.length) return;
    const d = new Date(at);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (day !== this.budgetDay) {
      this.budgetDay = day;
      this.budgetUsage.clear();
      this.budgetFired.clear();
      this.seedBudgets(at);
      return;
    }
    for (const b of this.settings.budgets) {
      if (!budgetMatches(b, seg)) continue;
      this.budgetUsage.set(b.id, (this.budgetUsage.get(b.id) ?? 0) + deltaMs);
      this.checkBudget(b);
    }
  }

  private seedBudgets(at: number): void {
    const d = new Date(at);
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const segs = this.options.store.querySegments({ from, to: at + 1 }).filter((s) => s.kind === 'active');
    for (const b of this.settings.budgets) {
      let ms = 0;
      for (const s of segs) if (budgetMatches(b, s)) ms += Math.min(s.end, at) - Math.max(s.start, from);
      this.budgetUsage.set(b.id, ms);
      this.checkBudget(b);
    }
  }

  private checkBudget(b: Budget): void {
    const used = (this.budgetUsage.get(b.id) ?? 0) / 60_000;
    for (const percent of [80, 100]) {
      const key = `${b.id}:${percent}`;
      if (used >= (b.dailyMinutes * percent) / 100 && !this.budgetFired.has(key)) {
        this.budgetFired.add(key);
        // Only the highest crossed threshold is announced.
        if (percent === 80 && used >= b.dailyMinutes) continue;
        this.options.onBudgetReminder?.({ budget: b, usedMinutes: Math.round(used), percent });
      }
    }
  }
}

function budgetMatches(b: Budget, s: { domain: string; category: Category }): boolean {
  return b.target.type === 'category' ? s.category === b.target.category : s.domain === b.target.domain || s.domain.endsWith('.' + b.target.domain);
}
