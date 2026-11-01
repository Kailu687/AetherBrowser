import type { ActivityStore } from './store.js';
import { CATEGORIES, type ActivityKind, type ActivitySegment, type Category, type FocusSessionEntry, type InterventionEntry } from './types.js';

export type KindTotals = Record<ActivityKind, number>;

export interface DomainTotals extends KindTotals {
  domain: string;
  category: Category;
}

export interface DaySummary {
  /** Local midnight. */
  dayStart: number;
  label: string;
  activeByCategory: Record<Category, number>;
  totals: KindTotals;
}

export interface InterrupterSummary {
  domain: string;
  attempts: number;
  wentBack: number;
  continued: number;
}

export interface ActivityReport {
  from: number;
  to: number;
  totals: KindTotals;
  byCategory: Record<Category, KindTotals>;
  byDomain: DomainTotals[];
  byProfile: Record<string, KindTotals>;
  byWorkspace: Record<string, KindTotals>;
  days: DaySummary[];
  focusSessions: FocusSessionEntry[];
  focusedMs: number;
  interventions: number;
  interrupters: InterrupterSummary[];
  /** Active time on education + research. */
  learningMs: number;
  /** Active time on entertainment + social. */
  leisureMs: number;
}

const zero = (): KindTotals => ({ active: 0, passive: 0, media: 0 });
const zeroCats = (): Record<Category, number> => Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;

export function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function addDays(dayStart: number, n: number): number {
  const d = new Date(dayStart);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

export function rangeFor(kind: 'today' | 'week', now: number): { from: number; to: number } {
  const today = startOfDay(now);
  return kind === 'today' ? { from: today, to: addDays(today, 1) } : { from: addDays(today, -6), to: addDays(today, 1) };
}

/** Pure aggregation; segments are clipped to the range and split at local midnights. */
export function summarize(
  segments: ActivitySegment[],
  range: { from: number; to: number },
  extra: { focusSessions?: FocusSessionEntry[]; interventions?: InterventionEntry[] } = {},
): ActivityReport {
  const totals = zero();
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, zero()])) as Record<Category, KindTotals>;
  const byDomain = new Map<string, DomainTotals>();
  const byProfile: Record<string, KindTotals> = {};
  const byWorkspace: Record<string, KindTotals> = {};
  const days: DaySummary[] = [];
  for (let d = startOfDay(range.from); d < range.to; d = addDays(d, 1)) {
    days.push({
      dayStart: d,
      label: new Date(d).toLocaleDateString('en', { weekday: 'short', day: 'numeric' }),
      activeByCategory: zeroCats(),
      totals: zero(),
    });
  }

  for (const s of segments) {
    const start = Math.max(s.start, range.from);
    const end = Math.min(s.end, range.to);
    if (end <= start) continue;
    const ms = end - start;
    totals[s.kind] += ms;
    byCategory[s.category][s.kind] += ms;
    let dt = byDomain.get(s.domain);
    if (!dt) byDomain.set(s.domain, (dt = { domain: s.domain, category: s.category, ...zero() }));
    dt[s.kind] += ms;
    (byProfile[s.profileId] ??= zero())[s.kind] += ms;
    if (s.workspaceId) (byWorkspace[s.workspaceId] ??= zero())[s.kind] += ms;
    for (const day of days) {
      const next = addDays(day.dayStart, 1);
      const ds = Math.max(start, day.dayStart);
      const de = Math.min(end, next);
      if (de <= ds) continue;
      day.totals[s.kind] += de - ds;
      if (s.kind === 'active') day.activeByCategory[s.category] += de - ds;
    }
  }

  const interrupters = new Map<string, InterrupterSummary>();
  for (const e of extra.interventions ?? []) {
    let it = interrupters.get(e.domain);
    if (!it) interrupters.set(e.domain, (it = { domain: e.domain, attempts: 0, wentBack: 0, continued: 0 }));
    it.attempts++;
    if (e.resolution === 'back') it.wentBack++;
    if (e.resolution === 'continue' || e.resolution === 'allow' || e.resolution === 'end') it.continued++;
  }
  const sessions = extra.focusSessions ?? [];
  return {
    from: range.from,
    to: range.to,
    totals,
    byCategory,
    byDomain: [...byDomain.values()].sort((a, b) => b.active - a.active || b.passive + b.media - (a.passive + a.media)),
    byProfile,
    byWorkspace,
    days,
    focusSessions: sessions,
    focusedMs: sessions.reduce((n, s) => n + s.focusedMs, 0),
    interventions: extra.interventions?.length ?? 0,
    interrupters: [...interrupters.values()].sort((a, b) => b.attempts - a.attempts),
    learningMs: byCategory.education.active + byCategory.research.active,
    leisureMs: byCategory.entertainment.active + byCategory.social.active,
  };
}

export function buildReport(store: ActivityStore, range: { from: number; to: number }, profileId?: string): ActivityReport {
  return summarize(store.querySegments({ ...range, profileId }), range, {
    focusSessions: store.queryFocusSessions(range),
    interventions: store.queryInterventions(range),
  });
}

function csvCell(v: unknown): string {
  const s = String(v ?? '');
  // Prefix formula-like cells so spreadsheets do not execute them.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One row per recorded segment. Contains domains and categories only, never full URLs. */
export function exportSegmentsCsv(segments: ActivitySegment[]): string {
  const header = ['start', 'end', 'seconds', 'kind', 'measured', 'domain', 'category', 'profile', 'workspace'];
  const rows = segments.map((s) =>
    [new Date(s.start).toISOString(), new Date(s.end).toISOString(), Math.round((s.end - s.start) / 1000), s.kind, s.kind === 'active' ? 'measured' : 'inferred', s.domain, s.category, s.profileId, s.workspaceId ?? '']
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n') + '\n';
}

export function exportReportJson(report: ActivityReport): string {
  return JSON.stringify(
    {
      format: 'aether.activity-report',
      version: 1,
      measurement: {
        active: 'Measured: window focused, tab in front, input within the idle threshold.',
        passive: 'Inferred: tab in front after input stopped, capped.',
        media: 'Inferred: tab playing audio while not actively used.',
      },
      ...report,
    },
    null,
    2,
  );
}
