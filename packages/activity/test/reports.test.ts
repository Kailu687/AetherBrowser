import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  MemoryActivityStore,
  SqlActivityStore,
  buildReport,
  categorize,
  exportSegmentsCsv,
  handleActivityPage,
  recordFocusEvents,
  renderDashboardHtml,
  summarize,
  ActivityTracker,
  type ActivityStore,
  type ActivitySegment,
} from '../src/index.js';

const MIN = 60_000;
const day = new Date(2026, 9, 29).getTime();
const seg = (h: number, minutes: number, domain: string, category: ActivitySegment['category'], kind: ActivitySegment['kind'] = 'active', extra: Partial<ActivitySegment> = {}): ActivitySegment => ({
  start: day + h * 3600_000,
  end: day + h * 3600_000 + minutes * MIN,
  kind,
  domain,
  category,
  profileId: 'vit',
  workspaceId: 'radar',
  ...extra,
});

describe('categorize', () => {
  it('uses known sites, academic suffixes, YouTube paths and overrides', () => {
    expect(categorize('https://scholar.google.com/scholar?q=x')).toBe('research');
    expect(categorize('https://www.google.com/search?q=x')).toBe('uncategorized');
    expect(categorize('https://vtop.vit.ac.in/')).toBe('education');
    expect(categorize('https://www.cse.iitm.ac.in/')).toBe('education');
    expect(categorize('https://www.youtube.com/shorts/abc')).toBe('entertainment');
    expect(categorize('https://www.youtube.com/watch?v=abc')).toBe('uncategorized');
    expect(categorize('https://www.youtube.com/watch?v=abc', { 'youtube.com': 'education' })).toBe('education');
    expect(categorize('https://web.whatsapp.com/')).toBe('communication');
  });
});

describe('summarize', () => {
  it('totals by kind, category, domain, profile and workspace, clipped to range', () => {
    const segs = [
      seg(9, 60, 'arxiv.org', 'research'),
      seg(10, 30, 'netflix.com', 'entertainment'),
      seg(11, 20, 'arxiv.org', 'research', 'passive', { workspaceId: null, profileId: 'personal' }),
      seg(-1, 120, 'github.com', 'productivity'), // starts the previous evening
    ];
    const r = summarize(segs, { from: day, to: day + 86_400_000 });
    expect(r.totals).toEqual({ active: 150 * MIN, passive: 20 * MIN, media: 0 });
    expect(r.byDomain[0]).toMatchObject({ domain: 'arxiv.org', active: 60 * MIN, passive: 20 * MIN });
    expect(r.learningMs).toBe(60 * MIN);
    expect(r.leisureMs).toBe(30 * MIN);
    expect(r.byProfile.personal!.passive).toBe(20 * MIN);
    expect(r.byWorkspace.radar!.active).toBe(150 * MIN);
    expect(r.days).toHaveLength(1);
  });

  it('splits a week into days and ranks interrupting sites', () => {
    const segs = [seg(10, 30, 'arxiv.org', 'research'), seg(24 + 10, 45, 'arxiv.org', 'research')];
    const r = summarize(segs, { from: day, to: day + 7 * 86_400_000 }, {
      interventions: [
        { at: day, domain: 'instagram.com', action: 'block', resolution: 'back', mode: 'study', sessionId: 's' },
        { at: day, domain: 'instagram.com', action: 'block', resolution: 'allow', mode: 'study', sessionId: 's' },
        { at: day, domain: 'reddit.com', action: 'warn', resolution: 'continue', mode: 'study', sessionId: 's' },
      ],
    });
    expect(r.days.map((d) => d.activeByCategory.research / MIN)).toEqual([30, 45, 0, 0, 0, 0, 0]);
    expect(r.interrupters[0]).toEqual({ domain: 'instagram.com', attempts: 2, wentBack: 1, continued: 1 });
  });
});

describe('exports and dashboard', () => {
  it('exports CSV with measured/inferred labels and neutralised formulas', () => {
    const csv = exportSegmentsCsv([seg(9, 1, '=cmd.example', 'uncategorized', 'passive')]);
    expect(csv.split('\n')[0]).toBe('start,end,seconds,kind,measured,domain,category,profile,workspace');
    expect(csv).toContain(",passive,inferred,'=cmd.example,");
  });

  it('renders a script-free dashboard that answers the key questions', () => {
    const r = summarize([seg(9, 60, 'arxiv.org', 'research'), seg(10, 30, 'netflix.com', 'entertainment')], { from: day, to: day + 7 * 86_400_000 }, {
      focusSessions: [{ id: 'f', mode: 'study', goal: 'Radar <b>chapter</b>', startedAt: day, endedAt: day + 50 * MIN, focusedMs: 50 * MIN, endReason: 'completed', completedWorkBlocks: 2, interventions: 1 }],
      interventions: [{ at: day, domain: 'instagram.com', action: 'block', resolution: 'back', mode: 'study', sessionId: 'f' }],
    });
    const html = renderDashboardHtml(r, { range: 'week', trackingEnabled: true, paused: false });
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('Learning &amp; research');
    expect(html).toContain('1h 30m');
    expect(html).toContain('Sites that pulled you away');
    expect(html).toContain('Radar &lt;b&gt;chapter&lt;/b&gt;');
    expect(html).toContain('How time is measured');
    expect(html).toContain('Active time per day');
  });

  it('shows a calm empty state and the off banner', () => {
    const html = renderDashboardHtml(summarize([], { from: day, to: day + 86_400_000 }), { range: 'today', trackingEnabled: false, paused: false });
    expect(html).toContain('No browsing recorded today yet');
    expect(html).toContain('Activity tracking is off');
  });
});

function storeContract(name: string, make: () => ActivityStore) {
  describe(`${name} store`, () => {
    it('stores, extends, queries and deletes records', () => {
      const s = make();
      const id = s.insertSegment(seg(9, 10, 'arxiv.org', 'research'));
      s.updateSegmentEnd(id, day + 9 * 3600_000 + 20 * MIN);
      s.insertSegment(seg(10, 10, 'netflix.com', 'entertainment', 'active', { profileId: 'personal' }));
      expect(s.querySegments({ from: day, to: day + 86_400_000 }).map((x) => (x.end - x.start) / MIN)).toEqual([20, 10]);
      expect(s.querySegments({ from: day, to: day + 86_400_000, profileId: 'personal' })).toHaveLength(1);
      s.insertIntervention({ at: day + 1, domain: 'netflix.com', action: 'warn', resolution: 'back', mode: 'study', sessionId: 'x' });
      s.upsertFocusSession({ id: 'x', mode: 'study', goal: 'g', startedAt: day, endedAt: day + MIN, focusedMs: MIN, endReason: 'completed', completedWorkBlocks: 1, interventions: 1 });
      s.upsertFocusSession({ id: 'x', mode: 'study', goal: 'g', startedAt: day, endedAt: day + 2 * MIN, focusedMs: 2 * MIN, endReason: 'completed', completedWorkBlocks: 1, interventions: 1 });
      const report = buildReport(s, { from: day, to: day + 86_400_000 });
      expect(report.focusSessions).toHaveLength(1);
      expect(report.focusedMs).toBe(2 * MIN);
      expect(report.interventions).toBe(1);
      s.deleteDomain('netflix.com');
      expect(s.querySegments({ from: day, to: day + 86_400_000 })).toHaveLength(1);
      expect(s.queryInterventions({ from: day, to: day + 86_400_000 })).toHaveLength(0);
      s.deleteProfile('vit');
      expect(s.querySegments({ from: day, to: day + 86_400_000 })).toHaveLength(0);
      s.insertSegment(seg(9, 10, 'a.com', 'uncategorized'));
      s.deleteRange(day, day + 86_400_000);
      expect(s.querySegments({ from: 0, to: Number.MAX_SAFE_INTEGER })).toHaveLength(0);
      s.insertSegment(seg(9, 10, 'a.com', 'uncategorized'));
      s.deleteAll();
      expect(s.querySegments({ from: 0, to: Number.MAX_SAFE_INTEGER })).toHaveLength(0);
      expect(s.queryFocusSessions({ from: 0, to: Number.MAX_SAFE_INTEGER })).toHaveLength(0);
    });
  });
}
storeContract('memory', () => new MemoryActivityStore());
storeContract('sqlite', () => new SqlActivityStore(new DatabaseSync(':memory:') as any));

describe('activity pages and focus wiring', () => {
  it('serves dashboard and exports, and records focus events except private ones', () => {
    const store = new MemoryActivityStore();
    const tracker = new ActivityTracker({ store, getIdleSeconds: () => 0, now: () => day + 12 * 3600_000 });
    const listeners: Record<string, (x: any) => void> = {};
    const focus = { on: (e: string, l: (x: any) => void) => ((listeners[e] = l), () => delete listeners[e]) } as any;
    recordFocusEvents(focus, store, () => true);
    listeners['intervention-resolved']!({ site: 'x.com', action: 'block', resolution: 'back', mode: 'study', sessionId: 's', createdAt: day + 1, profileId: 'vit' });
    listeners['intervention-resolved']!({ site: 'secret.com', action: 'block', resolution: 'back', mode: 'study', sessionId: 's', createdAt: day + 2, profileId: 'private' });
    listeners['session-ended']!({ id: 's', mode: 'study', goal: 'Lab', startedAt: day, endedAt: day + MIN, focusedMs: MIN, endReason: 'completed', completedWorkBlocks: 0, interventions: 1 });
    store.insertSegment(seg(9, 30, 'arxiv.org', 'research'));
    const page = handleActivityPage(new URL('aether://activity/?range=today'), { store, tracker, now: () => day + 12 * 3600_000 });
    expect('html' in page && page.html).toContain('x.com');
    expect('html' in page && page.html).not.toContain('secret.com');
    const csv = handleActivityPage(new URL('aether://activity/export.csv?range=week'), { store, tracker, now: () => day + 12 * 3600_000 });
    expect(csv).toMatchObject({ contentType: 'text/csv; charset=utf-8' });
    expect('body' in csv && csv.body).toContain('arxiv.org');
  });
});
