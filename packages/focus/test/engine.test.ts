import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebRequestHub } from '@aether/web-request-hub';
import { FocusEngine, defaultFocusSettings, handleInterventionPage, scheduleActiveAt, type FocusSessionRecord, type Intervention } from '../src/index.js';

const MIN = 60_000;
const nav = (e: FocusEngine, url: string, prev = 'https://docs.python.org/3/') => e.evaluateNavigation(url, { profileId: 'p1', previousUrl: prev });

function make(mutate?: (s: ReturnType<typeof defaultFocusSettings>) => void) {
  const settings = defaultFocusSettings();
  mutate?.(settings);
  return new FocusEngine({ settings });
}

describe('FocusEngine', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date(2026, 9, 29, 10, 0).getTime() }));
  afterEach(() => vi.useRealTimers());

  it('does nothing without an active session or in relaxed mode', () => {
    const e = make();
    expect(nav(e, 'https://instagram.com/').kind).toBe('allow');
    e.startSession({ mode: 'relaxed' });
    expect(nav(e, 'https://instagram.com/').kind).toBe('allow');
  });

  it('redirects a blocked page to the intervention screen and records it', () => {
    const e = make();
    const seen: Intervention[] = [];
    e.on('intervention', (i) => seen.push(i));
    e.startSession({ mode: 'deep-work', goal: 'Finish lab report', timer: false });
    const d = nav(e, 'https://www.instagram.com/explore');
    expect(d.kind).toBe('intervene');
    if (d.kind !== 'intervene') return;
    expect(d.redirectUrl).toBe(`aether://intervention/?id=${d.intervention.id}`);
    expect(seen[0]).toMatchObject({ site: 'instagram.com', action: 'block', returnUrl: 'https://docs.python.org/3/', goal: 'Finish lab report' });
    expect(e.status().session?.interruptedSites).toEqual({ 'instagram.com': 1 });
  });

  it('keeps docs reachable in deep work', () => {
    const e = make();
    e.startSession({ mode: 'deep-work', timer: false });
    expect(nav(e, 'https://developer.mozilla.org/en-US/').kind).toBe('allow');
  });

  it('"go back" returns to the previous page', () => {
    const e = make();
    e.startSession({ mode: 'deep-work', timer: false });
    const d = nav(e, 'https://netflix.com/');
    if (d.kind !== 'intervene') throw new Error();
    expect(e.resolveIntervention(d.intervention.id, 'back')).toEqual({ redirect: 'https://docs.python.org/3/' });
    expect(e.status().session?.returned).toBe(1);
    expect(e.getIntervention(d.intervention.id)).toBeUndefined();
  });

  it('continue on a warning requires the strictness pause, then passes once', () => {
    const e = make();
    e.startSession({ mode: 'deep-work', timer: false });
    const d = nav(e, 'https://www.youtube.com/watch?v=1');
    if (d.kind !== 'intervene') throw new Error();
    const early = e.resolveIntervention(d.intervention.id, 'continue');
    expect(early).toMatchObject({ error: expect.stringContaining('wait') });
    vi.advanceTimersByTime(5000);
    expect(e.resolveIntervention(d.intervention.id, 'continue')).toEqual({ redirect: 'https://www.youtube.com/watch?v=1' });
    expect(nav(e, 'https://www.youtube.com/watch?v=1').kind).toBe('allow');
    expect(nav(e, 'https://www.youtube.com/watch?v=1').kind).toBe('allow');
    // The pass covers that page for a minute only, not the whole site.
    expect(nav(e, 'https://www.youtube.com/watch?v=2').kind).toBe('intervene');
    vi.advanceTimersByTime(60_000);
    expect(nav(e, 'https://www.youtube.com/watch?v=1').kind).toBe('intervene');
  });

  it('does not offer continue for blocked sites, but allows a timed allowance', () => {
    const e = make();
    e.startSession({ mode: 'deep-work', timer: false });
    const d = nav(e, 'https://x.com/home');
    if (d.kind !== 'intervene') throw new Error();
    vi.advanceTimersByTime(10_000);
    expect(e.resolveIntervention(d.intervention.id, 'continue')).toHaveProperty('error');
    expect(e.resolveIntervention(d.intervention.id, 'allow', 60)).toHaveProperty('error');
    expect(e.resolveIntervention(d.intervention.id, 'allow', 15)).toEqual({ redirect: 'https://x.com/home' });
    expect(nav(e, 'https://x.com/other').kind).toBe('allow');
    vi.advanceTimersByTime(15 * MIN);
    expect(nav(e, 'https://x.com/other').kind).toBe('intervene');
  });

  it('ending the session from the screen opens the site and records the session', () => {
    const e = make();
    const ended: FocusSessionRecord[] = [];
    e.on('session-ended', (r) => ended.push(r));
    e.startSession({ mode: 'deep-work', goal: 'Read paper', timer: false });
    vi.advanceTimersByTime(20 * MIN);
    const d = nav(e, 'https://reddit.com/');
    if (d.kind !== 'intervene') throw new Error();
    expect(e.resolveIntervention(d.intervention.id, 'end')).toEqual({ redirect: 'https://reddit.com/' });
    expect(e.status().active).toBe(false);
    expect(ended[0]).toMatchObject({ endReason: 'ended-from-intervention', focusedMs: 20 * MIN, interventions: 1, goal: 'Read paper' });
  });

  it('applies the grace period, pause and always-allowed sites', () => {
    const e = make((s) => (s.alwaysAllowed = ['instagram.com/vitchennai']));
    e.startSession({ mode: 'study', timer: false });
    expect(nav(e, 'https://facebook.com/').kind).toBe('allow');
    vi.advanceTimersByTime(60_000);
    expect(nav(e, 'https://facebook.com/').kind).toBe('intervene');
    expect(nav(e, 'https://instagram.com/vitchennai').kind).toBe('allow');
    e.pauseSession();
    expect(nav(e, 'https://facebook.com/').kind).toBe('allow');
    e.resumeSession();
    expect(nav(e, 'https://facebook.com/').kind).toBe('intervene');
  });

  it('relaxes rules during Pomodoro breaks', () => {
    const e = make();
    e.startSession({ mode: 'deep-work', timer: { workMinutes: 25, shortBreakMinutes: 5 } });
    expect(nav(e, 'https://netflix.com/').kind).toBe('intervene');
    vi.advanceTimersByTime(25 * MIN);
    expect(e.status().timer?.phase).toBe('short-break');
    expect(nav(e, 'https://netflix.com/').kind).toBe('allow');
  });

  it('completes a planned-length session automatically', () => {
    const e = make();
    const ended: FocusSessionRecord[] = [];
    e.on('session-ended', (r) => ended.push(r));
    e.startSession({ mode: 'research', plannedMinutes: 30, timer: false });
    vi.advanceTimersByTime(10 * MIN);
    e.pauseSession();
    vi.advanceTimersByTime(60 * MIN);
    expect(e.status().active).toBe(true);
    e.resumeSession();
    vi.advanceTimersByTime(20 * MIN);
    expect(ended[0]).toMatchObject({ endReason: 'completed', focusedMs: 30 * MIN });
  });

  it('blocks embedded content only for embedded-scope block rules', () => {
    const e = make((s) => s.modes['deep-work'].rules.push({ id: 'emb', pattern: 'tiktok.com', action: 'block', scope: 'embedded' }));
    e.startSession({ mode: 'deep-work', timer: false });
    expect(e.evaluateNavigation('https://www.tiktok.com/embed/1', { profileId: 'p1' }, 'embedded').kind).toBe('cancel');
    expect(e.evaluateNavigation('https://www.youtube.com/embed/1', { profileId: 'p1' }, 'embedded').kind).toBe('allow');
  });

  it('skips excluded profiles and labels private interventions without the profile id', () => {
    const e = make((s) => (s.excludedProfiles = ['startup']));
    e.startSession({ mode: 'deep-work', timer: false });
    expect(e.evaluateNavigation('https://netflix.com/', { profileId: 'startup' }).kind).toBe('allow');
    const d = e.evaluateNavigation('https://netflix.com/', { profileId: 'p1', isPrivate: true });
    expect(d.kind === 'intervene' && d.intervention.profileId).toBe('private');
  });

  it('works through the web request hub for main frames only', async () => {
    const e = make();
    e.startSession({ mode: 'deep-work', timer: false });
    const hub = new WebRequestHub();
    hub.use(e.handler());
    const base = { id: 1, method: 'GET', webContentsId: 3, topLevelUrl: '', referrer: '', sessionKey: 'p1' };
    expect(await hub.runBeforeRequest({ ...base, url: 'https://netflix.com/', resourceType: 'mainFrame' })).toHaveProperty('redirectURL');
    expect(await hub.runBeforeRequest({ ...base, url: 'https://netflix.com/app.js', resourceType: 'script' })).toEqual({});
    expect(await hub.runBeforeRequest({ ...base, url: 'https://netflix.com/', resourceType: 'mainFrame', method: 'POST' })).toEqual({});
  });

  it('survives a restart: session, timer and allowances are restored', () => {
    const e = make();
    let state: any;
    e.on('state-changed', (s) => (state = JSON.parse(JSON.stringify(s))));
    e.startSession({ mode: 'deep-work', goal: 'VLSI prep', timer: { workMinutes: 50 } });
    const d = nav(e, 'https://x.com/');
    if (d.kind !== 'intervene') throw new Error();
    vi.advanceTimersByTime(5000);
    e.resolveIntervention(d.intervention.id, 'allow', 15);
    vi.advanceTimersByTime(10 * MIN);
    e.dispose();
    const restored = new FocusEngine({ settings: defaultFocusSettings(), state });
    expect(restored.status()).toMatchObject({ active: true, session: { goal: 'VLSI prep' } });
    expect(restored.status().timer?.remainingMs).toBe(40 * MIN - 5000);
    expect(nav(restored, 'https://x.com/').kind).toBe('allow');
  });

  it('starts and ends scheduled sessions and respects a manual end', () => {
    const e = make((s) => (s.schedules = [{ id: 's1', mode: 'study', days: [0, 1, 2, 3, 4, 5, 6], start: '10:00', end: '11:00', enabled: true }]));
    e.tick();
    expect(e.status().session?.source).toBe('schedule');
    e.endSession();
    e.tick();
    expect(e.status().active).toBe(false);
    vi.setSystemTime(new Date(2026, 9, 30, 10, 30));
    e.tick();
    expect(e.status().active).toBe(true);
    vi.setSystemTime(new Date(2026, 9, 30, 11, 0));
    e.tick();
    expect(e.status().active).toBe(false);
  });

  it('handles schedules that cross midnight', () => {
    const s = { id: 'n', mode: 'study' as const, days: [3], start: '22:00', end: '01:00', enabled: true };
    expect(scheduleActiveAt(s, new Date(2026, 9, 28, 23, 0).getTime())).toBe(true); // Wednesday
    expect(scheduleActiveAt(s, new Date(2026, 9, 29, 0, 30).getTime())).toBe(true); // Thursday early
    expect(scheduleActiveAt(s, new Date(2026, 9, 29, 23, 0).getTime())).toBe(false);
  });

  it('emits a gentle notification when a session ends', () => {
    const e = make();
    const notes: string[] = [];
    e.on('notify', (n) => notes.push(n.body));
    e.startSession({ mode: 'research', goal: 'Radar papers', timer: false });
    vi.advanceTimersByTime(42 * MIN);
    e.endSession();
    expect(notes).toEqual(['42 min focused on "Radar papers".']);
  });
});

describe('intervention page', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  it('renders choices as plain links with a strict CSP and escapes page data', () => {
    const e = make();
    e.startSession({ mode: 'deep-work', goal: '<script>alert(1)</script>', timer: false });
    const d = nav(e, 'https://netflix.com/"><img>');
    if (d.kind !== 'intervene') throw new Error();
    const res = handleInterventionPage(e, new URL(d.redirectUrl));
    if (!('html' in res)) throw new Error();
    expect(res.headers?.['Content-Security-Policy']).toContain("default-src 'none'");
    expect(res.html).not.toContain('<script>');
    expect(res.html).toContain('&lt;script&gt;');
    expect(res.html).toContain(`choice=back`);
    expect(res.html).toContain('Allow for 5 min');
    expect(res.html).not.toContain('Continue to the page');
    expect(res.html).toContain('End the focus session');
  });

  it('resolves through a GET URL and shows a notice when the choice is not ready', () => {
    const e = make();
    e.startSession({ mode: 'deep-work', timer: false });
    const d = nav(e, 'https://www.youtube.com/watch?v=1');
    if (d.kind !== 'intervene') throw new Error();
    const early = handleInterventionPage(e, new URL(`aether://intervention/resolve?id=${d.intervention.id}&choice=continue`));
    expect('redirect' in early && early.redirect).toContain('notice=');
    vi.advanceTimersByTime(5000);
    const ok = handleInterventionPage(e, new URL(`aether://intervention/resolve?id=${d.intervention.id}&choice=continue`));
    expect(ok).toEqual({ redirect: 'https://www.youtube.com/watch?v=1' });
  });

  it('treats unknown or expired ids safely', () => {
    const e = make();
    const res = handleInterventionPage(e, new URL('aether://intervention/?id=nope'));
    expect('html' in res && res.html).toContain('expired');
    expect(handleInterventionPage(e, new URL('aether://intervention/resolve?id=nope&choice=continue'))).toEqual({ redirect: 'aether://newtab/' });
  });
});
