import { describe, expect, it } from 'vitest';
import { ActivityTracker, MemoryActivityStore, defaultActivitySettings, type ActivitySettings, type BudgetReminder, type TabInfo } from '../src/index.js';

const S = 1000;
const MIN = 60 * S;

function setup(patch: Partial<ActivitySettings> = {}) {
  let now = new Date(2026, 9, 29, 9, 0).getTime();
  let idle = 0;
  const store = new MemoryActivityStore();
  const reminders: BudgetReminder[] = [];
  const tracker = new ActivityTracker({
    store,
    settings: { ...defaultActivitySettings(), ...patch },
    getIdleSeconds: () => idle,
    now: () => now,
    onBudgetReminder: (r) => reminders.push(r),
  });
  const advance = (ms: number, idleAfter?: number) => {
    // Simulate 15 s ticks; idle grows when idleAfter is set.
    const step = 15 * S;
    for (let t = 0; t < ms; t += step) {
      const d = Math.min(step, ms - t);
      now += d;
      if (idleAfter !== undefined) idle += d / 1000;
      tracker.tick();
    }
  };
  const setIdle = (s: number) => (idle = s);
  const segs = () => store.querySegments({ from: 0, to: Number.MAX_SAFE_INTEGER });
  const sum = (kind: string, domain?: string) => segs().filter((s) => s.kind === kind && (!domain || s.domain === domain)).reduce((n, s) => n + s.end - s.start, 0);
  return { tracker, store, advance, setIdle, segs, sum, reminders, now: () => now };
}

const tab = (over: Partial<TabInfo> = {}): TabInfo => ({ tabId: 1, windowId: 1, url: 'https://arxiv.org/abs/2401.00001', profileId: 'vit', workspaceId: 'ser', isPrivate: false, ...over });

describe('ActivityTracker', () => {
  it('counts active time for the focused window front tab only', () => {
    const t = setup();
    t.tracker.windowFocusChanged({ windowId: 1, focused: true });
    t.tracker.activeTabChanged(tab());
    t.tracker.tabNavigated(tab({ tabId: 2, url: 'https://netflix.com/' })); // background tab
    t.advance(10 * MIN);
    t.tracker.flush();
    expect(t.sum('active', 'arxiv.org')).toBe(10 * MIN);
    expect(t.sum('active', 'netflix.com')).toBe(0);
    expect(t.segs()[0]).toMatchObject({ category: 'research', profileId: 'vit', workspaceId: 'ser' });
  });

  it('stores only the registrable domain, not the URL', () => {
    const t = setup();
    t.tracker.windowFocusChanged({ windowId: 1, focused: true });
    t.tracker.activeTabChanged(tab({ url: 'https://www.ieeexplore.ieee.org/document/123?token=secret' }));
    t.advance(MIN);
    t.tracker.flush();
    expect(JSON.stringify(t.segs())).not.toContain('secret');
    expect(t.segs()[0]!.domain).toBe('ieee.org');
  });

  it('stops when the window loses focus or is minimised', () => {
    const t = setup();
    t.tracker.windowFocusChanged({ windowId: 1, focused: true });
    t.tracker.activeTabChanged(tab());
    t.advance(5 * MIN);
    t.tracker.windowFocusChanged({ windowId: 1, focused: false });
    t.advance(5 * MIN);
    t.tracker.windowFocusChanged({ windowId: 1, focused: true });
    t.advance(2 * MIN);
    t.tracker.windowMinimized({ windowId: 1, minimized: true });
    t.advance(5 * MIN);
    t.tracker.flush();
    expect(t.sum('active')).toBe(7 * MIN);
  });

  it('backdates idle: active ends when input stopped, then passive up to the cap', () => {
    const t = setup({ idleThresholdSeconds: 60, maxPassiveMinutes: 10 });
    t.tracker.windowFocusChanged({ windowId: 1, focused: true });
    t.tracker.activeTabChanged(tab());
    t.advance(5 * MIN);
    t.setIdle(0);
    t.advance(30 * MIN, 0);
    t.tracker.flush();
    expect(t.sum('active')).toBe(5 * MIN);
    expect(t.sum('passive')).toBe(10 * MIN);
  });

  it('resumes active time from when input came back', () => {
    const t = setup();
    t.tracker.windowFocusChanged({ windowId: 1, focused: true });
    t.tracker.activeTabChanged(tab());
    t.advance(2 * MIN, 0); // idle from the start
    t.setIdle(5); // input 5 s ago
    t.advance(15 * S);
    t.setIdle(0);
    t.advance(MIN);
    t.tracker.flush();
    // 2 min idle-in-front is passive; active restarts 5 s before the tick that noticed it.
    expect(t.sum('passive')).toBe(2 * MIN + 10 * S);
    expect(t.sum('active')).toBe(MIN + 5 * S);
  });

  it('counts audible tabs as media, including lectures in the background', () => {
    const t = setup();
    t.tracker.windowFocusChanged({ windowId: 1, focused: true });
    t.tracker.activeTabChanged(tab());
    t.tracker.tabNavigated(tab({ tabId: 2, url: 'https://www.youtube.com/watch?v=lecture' }));
    t.tracker.tabAudible({ tabId: 2, audible: true });
    t.advance(10 * MIN);
    t.tracker.flush();
    expect(t.sum('active', 'arxiv.org')).toBe(10 * MIN);
    expect(t.sum('media', 'youtube.com')).toBe(10 * MIN);
  });

  it('never records private windows, excluded profiles or excluded domains', () => {
    const t = setup({ excludedProfiles: ['startup'], excludedDomains: ['bank.com'] });
    t.tracker.windowFocusChanged({ windowId: 1, focused: true });
    t.tracker.activeTabChanged(tab({ isPrivate: true }));
    t.advance(MIN);
    t.tracker.activeTabChanged(tab({ profileId: 'startup' }));
    t.advance(MIN);
    t.tracker.activeTabChanged(tab({ url: 'https://netbanking.bank.com/' }));
    t.advance(MIN);
    t.tracker.activeTabChanged(tab({ url: 'aether://settings' }));
    t.advance(MIN);
    t.tracker.flush();
    expect(t.segs()).toEqual([]);
  });

  it('pause, disable and system suspend stop recording', () => {
    const t = setup();
    t.tracker.windowFocusChanged({ windowId: 1, focused: true });
    t.tracker.activeTabChanged(tab());
    t.advance(MIN);
    t.tracker.pause(5);
    t.advance(5 * MIN);
    t.advance(MIN); // pause expired
    t.tracker.systemSuspended();
    t.advance(10 * MIN);
    t.tracker.systemResumed();
    t.advance(MIN);
    t.tracker.setSettings({ ...t.tracker.getSettings(), enabled: false });
    t.advance(10 * MIN);
    t.tracker.flush();
    expect(t.sum('active')).toBe(3 * MIN);
  });

  it('checkpoints long segments into one row so a crash loses at most a minute', () => {
    const t = setup();
    t.tracker.windowFocusChanged({ windowId: 1, focused: true });
    t.tracker.activeTabChanged(tab());
    t.advance(10 * MIN);
    // No flush: simulate a crash. The store already holds nearly everything in one row.
    const segs = t.segs();
    expect(segs).toHaveLength(1);
    expect(t.sum('active')).toBeGreaterThanOrEqual(9 * MIN);
  });

  it('splits segments when the tab navigates to another site', () => {
    const t = setup();
    t.tracker.windowFocusChanged({ windowId: 1, focused: true });
    t.tracker.activeTabChanged(tab());
    t.advance(MIN);
    t.tracker.tabNavigated(tab({ url: 'https://github.com/x/y' }));
    t.advance(2 * MIN);
    t.tracker.tabClosed({ tabId: 1 });
    t.advance(MIN);
    t.tracker.flush();
    expect(t.segs().map((s) => [s.domain, s.category, (s.end - s.start) / MIN])).toEqual([
      ['arxiv.org', 'research', 1],
      ['github.com', 'productivity', 2],
    ]);
  });

  it('announces a daily budget once at 80% and once at 100%', () => {
    const t = setup({ budgets: [{ id: 'b', target: { type: 'category', category: 'entertainment' }, dailyMinutes: 10 }] });
    t.tracker.windowFocusChanged({ windowId: 1, focused: true });
    t.tracker.activeTabChanged(tab({ url: 'https://netflix.com/' }));
    t.advance(15 * MIN);
    expect(t.reminders.map((r) => r.percent)).toEqual([80, 100]);
  });

  it('applies retention limits', () => {
    const t = setup({ retentionDays: 1 });
    t.store.insertSegment({ start: 0, end: 1000, kind: 'active', domain: 'old.com', category: 'uncategorized', profileId: 'p', workspaceId: null });
    t.tracker.applyRetention();
    expect(t.segs()).toEqual([]);
  });
});
