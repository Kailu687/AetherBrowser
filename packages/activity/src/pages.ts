import { DASHBOARD_CSP, renderDashboardHtml } from './dashboard.js';
import { buildReport, exportReportJson, exportSegmentsCsv, rangeFor } from './reports.js';
import type { ActivityStore } from './store.js';
import type { ActivityTracker } from './tracker.js';

export type ActivityPageResult =
  | { html: string; headers?: Record<string, string> }
  | { body: string; contentType: string; headers?: Record<string, string> };

export interface ActivityPageOptions {
  store: ActivityStore;
  tracker: ActivityTracker;
  now?: () => number;
  profileNames?(): Record<string, string>;
  workspaceNames?(): Record<string, string>;
}

/** Serves aether://activity/ (dashboard), export.csv and export.json. */
export function handleActivityPage(url: URL, opts: ActivityPageOptions): ActivityPageResult {
  const now = (opts.now ?? Date.now)();
  const range = url.searchParams.get('range') === 'week' ? 'week' : 'today';
  const r = rangeFor(range, now);
  // Write open segments first so the page includes the last minute.
  opts.tracker.flush();
  const path = url.pathname.replace(/^\/+/, '');
  const stamp = new Date(now).toISOString().slice(0, 10);
  if (path === 'export.csv') {
    return {
      body: exportSegmentsCsv(opts.store.querySegments(r)),
      contentType: 'text/csv; charset=utf-8',
      headers: { 'Content-Disposition': `attachment; filename="aether-activity-${range}-${stamp}.csv"` },
    };
  }
  const report = buildReport(opts.store, r);
  if (path === 'export.json') {
    return {
      body: exportReportJson(report),
      contentType: 'application/json; charset=utf-8',
      headers: { 'Content-Disposition': `attachment; filename="aether-activity-${range}-${stamp}.json"` },
    };
  }
  const settings = opts.tracker.getSettings();
  return {
    html: renderDashboardHtml(report, {
      range,
      trackingEnabled: settings.enabled,
      paused: !!settings.pausedUntil && settings.pausedUntil > now,
      profileNames: opts.profileNames?.(),
      workspaceNames: opts.workspaceNames?.(),
    }),
    headers: { 'Content-Security-Policy': DASHBOARD_CSP },
  };
}

/** Structural view of @aether/focus's FocusEngine events, so this package does not depend on it. */
export interface FocusEventSource {
  on(event: 'session-ended', l: (r: { id: string; mode: string; goal: string; startedAt: number; endedAt: number; focusedMs: number; endReason: string; completedWorkBlocks: number; interventions: number }) => void): () => void;
  on(event: 'intervention-resolved', l: (i: { site: string; action: 'warn' | 'block'; resolution?: string; mode: string; sessionId: string; createdAt: number; profileId: string }) => void): () => void;
}

/**
 * Records finished focus sessions and resolved interventions. Interventions in private
 * windows are skipped, matching the rule that private browsing leaves no history.
 */
export function recordFocusEvents(focus: FocusEventSource, store: ActivityStore, isTracking: () => boolean): () => void {
  const offs = [
    focus.on('session-ended', (r) => {
      if (!isTracking()) return;
      store.upsertFocusSession({
        id: r.id,
        mode: r.mode,
        goal: r.goal,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        focusedMs: r.focusedMs,
        endReason: r.endReason,
        completedWorkBlocks: r.completedWorkBlocks,
        interventions: r.interventions,
      });
    }),
    focus.on('intervention-resolved', (i) => {
      if (!isTracking() || i.profileId === 'private') return;
      store.insertIntervention({ at: i.createdAt, domain: i.site, action: i.action, resolution: i.resolution, mode: i.mode, sessionId: i.sessionId });
    }),
  ];
  return () => offs.forEach((off) => off());
}
