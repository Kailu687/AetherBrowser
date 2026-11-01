import { randomUUID } from 'node:crypto';
import type { RequestContext, RequestHandler } from '@aether/web-request-hub';
import { getDomain } from 'tldts';
import { Emitter } from './emitter.js';
import { STRICTNESS, defaultModes, type FocusMode, type ModeConfig, type StrictnessPolicy } from './modes.js';
import { evaluateRules, type FocusRule, type RuleAction } from './rules.js';
import { PomodoroTimer, type TimerConfig, type TimerSnapshot, type TimerState } from './timer.js';

export interface FocusSchedule {
  id: string;
  mode: FocusMode;
  /** 0 = Sunday ... 6 = Saturday. */
  days: number[];
  /** Local time "HH:MM". */
  start: string;
  end: string;
  enabled: boolean;
}

export interface FocusSettings {
  modes: Record<FocusMode, ModeConfig>;
  /** Sites that are never interrupted in any mode, e.g. a university portal. */
  alwaysAllowed: string[];
  schedules: FocusSchedule[];
  /** Relax rules during Pomodoro breaks. */
  relaxDuringBreaks: boolean;
  notifications: boolean;
  /** Profiles where focus rules never apply. */
  excludedProfiles: string[];
}

export function defaultFocusSettings(): FocusSettings {
  return { modes: defaultModes(), alwaysAllowed: [], schedules: [], relaxDuringBreaks: true, notifications: true, excludedProfiles: [] };
}

export type SessionEndReason = 'completed' | 'ended-by-user' | 'ended-from-intervention' | 'schedule-ended' | 'replaced';

export interface FocusSessionState {
  id: string;
  mode: FocusMode;
  goal: string;
  source: 'manual' | 'schedule';
  scheduleId?: string;
  startedAt: number;
  /** Planned length without Pomodoro; the session completes when reached. */
  plannedMinutes?: number;
  pausedAt?: number;
  pausedMs: number;
  timer?: TimerState;
  interventions: number;
  continued: number;
  returned: number;
  allowed: number;
  interruptedSites: Record<string, number>;
}

export interface FocusSessionRecord {
  id: string;
  mode: FocusMode;
  goal: string;
  startedAt: number;
  endedAt: number;
  endReason: SessionEndReason;
  /** Elapsed time minus pauses (and minus breaks for Pomodoro sessions). */
  focusedMs: number;
  plannedMinutes?: number;
  completedWorkBlocks: number;
  interventions: number;
  continued: number;
  returned: number;
  allowed: number;
  interruptedSites: Record<string, number>;
}

export type InterventionChoice = 'back' | 'continue' | 'allow' | 'end';

export interface Intervention {
  id: string;
  sessionId: string;
  mode: FocusMode;
  url: string;
  site: string;
  ruleId: string;
  pattern: string;
  label?: string;
  action: Exclude<RuleAction, 'allow'>;
  createdAt: number;
  returnUrl: string;
  goal: string;
  profileId: string;
  resolution?: InterventionChoice;
  resolvedAt?: number;
}

export interface InterventionOptions {
  continueAfterSeconds: number | null;
  allowAfterSeconds: number;
  allowMinutes: number[];
}

export type NavigationDecision = { kind: 'allow' } | { kind: 'intervene'; redirectUrl: string; intervention: Intervention } | { kind: 'cancel' };

export type ResolveResult = { redirect: string } | { error: string; redirect: string };

type FocusEvents = {
  'session-started': FocusSessionState;
  'session-changed': FocusStatus;
  'session-ended': FocusSessionRecord;
  intervention: Intervention;
  'intervention-resolved': Intervention;
  'embedded-blocked': { url: string; site: string; ruleId: string; at: number };
  notify: { title: string; body: string };
  /** Persist this (e.g. JSON in the database) so a running session survives a crash or restart. */
  'state-changed': PersistedFocusState;
};

export interface FocusStatus {
  active: boolean;
  session?: FocusSessionState;
  modeConfig?: ModeConfig;
  timer?: TimerSnapshot;
  paused: boolean;
  enforcing: boolean;
  elapsedMs: number;
  remainingMs?: number;
}

export interface PersistedFocusState {
  session?: FocusSessionState;
  allowances: Record<string, number>;
  dismissedSchedules: string[];
}

export interface FocusEngineOptions {
  settings?: FocusSettings;
  state?: PersistedFocusState;
  now?: () => number;
  /** Base URL of the intervention internal page. */
  interventionBaseUrl?: string;
  newTabUrl?: string;
  /** Returns the URL a tab is currently showing, used as the "go back" target. */
  getCurrentUrl?(webContentsId: number): string | undefined;
  timerClock?: ConstructorParameters<typeof PomodoroTimer>[1];
}

const CONTINUE_PASS_MS = 60_000;
const MAX_PENDING = 200;

export class FocusEngine extends Emitter<FocusEvents> {
  private settings: FocusSettings;
  private session: FocusSessionState | undefined;
  private timer: PomodoroTimer | undefined;
  private timerOff: (() => void)[] = [];
  private allowances = new Map<string, number>();
  private continuePasses = new Map<string, number>();
  private readonly pending = new Map<string, Intervention>();
  private dismissedSchedules = new Set<string>();
  private endTimeout: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  readonly interventionBaseUrl: string;
  private readonly newTabUrl: string;

  constructor(private readonly options: FocusEngineOptions = {}) {
    super();
    this.now = options.now ?? Date.now;
    this.settings = options.settings ?? defaultFocusSettings();
    this.interventionBaseUrl = options.interventionBaseUrl ?? 'aether://intervention/';
    this.newTabUrl = options.newTabUrl ?? 'aether://newtab/';
    if (options.state) this.restore(options.state);
  }

  // ---- settings -------------------------------------------------------------

  getSettings(): FocusSettings {
    return this.settings;
  }

  setSettings(settings: FocusSettings): void {
    this.settings = settings;
    this.changed();
  }

  setModeRules(mode: FocusMode, rules: FocusRule[]): void {
    this.settings = { ...this.settings, modes: { ...this.settings.modes, [mode]: { ...this.settings.modes[mode], rules } } };
    this.changed();
  }

  // ---- sessions -------------------------------------------------------------

  startSession(opts: { mode: FocusMode; goal?: string; plannedMinutes?: number; timer?: Partial<TimerConfig> | false; source?: 'manual' | 'schedule'; scheduleId?: string }): FocusSessionState {
    if (this.session) this.endSession('replaced');
    const modeConfig = this.settings.modes[opts.mode];
    const timerConfig =
      opts.timer === false
        ? undefined
        : opts.timer ?? (modeConfig.defaultTimer ? { workMinutes: modeConfig.defaultTimer.workMinutes, shortBreakMinutes: modeConfig.defaultTimer.breakMinutes } : undefined);
    this.session = {
      id: randomUUID(),
      mode: opts.mode,
      goal: (opts.goal ?? '').slice(0, 200),
      source: opts.source ?? 'manual',
      scheduleId: opts.scheduleId,
      startedAt: this.now(),
      plannedMinutes: timerConfig ? undefined : opts.plannedMinutes,
      pausedMs: 0,
      interventions: 0,
      continued: 0,
      returned: 0,
      allowed: 0,
      interruptedSites: {},
    };
    this.allowances.clear();
    this.continuePasses.clear();
    if (timerConfig) {
      this.attachTimer(new PomodoroTimer(timerConfig, this.options.timerClock));
      this.timer!.start();
    }
    this.scheduleEnd();
    this.emit('session-started', this.session);
    this.changed();
    return this.session;
  }

  pauseSession(): void {
    const s = this.session;
    if (!s || s.pausedAt !== undefined) return;
    s.pausedAt = this.now();
    this.timer?.pause();
    this.clearEndTimeout();
    this.changed();
  }

  resumeSession(): void {
    const s = this.session;
    if (!s || s.pausedAt === undefined) return;
    s.pausedMs += this.now() - s.pausedAt;
    s.pausedAt = undefined;
    this.timer?.resume();
    this.scheduleEnd();
    this.changed();
  }

  /** Starts the next Pomodoro phase when auto-start is off. */
  startNextPhase(): void {
    if (this.session?.pausedAt === undefined) this.timer?.start();
  }

  skipPhase(): void {
    this.timer?.skip();
  }

  endSession(reason: SessionEndReason = 'ended-by-user'): FocusSessionRecord | undefined {
    const s = this.session;
    if (!s) return undefined;
    const endedAt = this.now();
    if (s.pausedAt !== undefined) s.pausedMs += endedAt - s.pausedAt;
    const timerSnap = this.timer?.snapshot();
    const focusedMs = this.timer ? this.timer.workMs() : Math.max(0, endedAt - s.startedAt - s.pausedMs);
    this.timer?.stop();
    this.detachTimer();
    this.clearEndTimeout();
    if (s.source === 'schedule' && s.scheduleId && reason !== 'schedule-ended') this.dismissedSchedules.add(this.scheduleWindowKey(s.scheduleId, endedAt));
    const record: FocusSessionRecord = {
      id: s.id,
      mode: s.mode,
      goal: s.goal,
      startedAt: s.startedAt,
      endedAt,
      endReason: reason,
      focusedMs,
      plannedMinutes: s.plannedMinutes,
      completedWorkBlocks: timerSnap?.completedWorkBlocks ?? 0,
      interventions: s.interventions,
      continued: s.continued,
      returned: s.returned,
      allowed: s.allowed,
      interruptedSites: { ...s.interruptedSites },
    };
    this.session = undefined;
    this.allowances.clear();
    this.continuePasses.clear();
    this.pending.clear();
    this.emit('session-ended', record);
    if (this.settings.notifications) {
      const minutes = Math.round(focusedMs / 60_000);
      this.emit('notify', { title: 'Focus session ended', body: `${minutes} min focused${record.goal ? ` on "${record.goal}"` : ''}.` });
    }
    this.changed();
    return record;
  }

  status(): FocusStatus {
    const s = this.session;
    if (!s) return { active: false, paused: false, enforcing: false, elapsedMs: 0 };
    const now = this.now();
    const pausedMs = s.pausedMs + (s.pausedAt !== undefined ? now - s.pausedAt : 0);
    const elapsedMs = Math.max(0, now - s.startedAt - pausedMs);
    return {
      active: true,
      session: { ...s },
      modeConfig: this.settings.modes[s.mode],
      timer: this.timer?.snapshot(),
      paused: s.pausedAt !== undefined,
      enforcing: this.isEnforcing(),
      elapsedMs,
      remainingMs: s.plannedMinutes ? Math.max(0, s.plannedMinutes * 60_000 - elapsedMs) : this.timer?.snapshot().remainingMs,
    };
  }

  /** True when rules are currently applied (session running, not paused, past grace, not on a break). */
  isEnforcing(): boolean {
    const s = this.session;
    if (!s || s.pausedAt !== undefined) return false;
    const mode = this.settings.modes[s.mode];
    if (this.now() < s.startedAt + mode.graceSeconds * 1000) return false;
    if (this.settings.relaxDuringBreaks && this.timer) {
      const t = this.timer.snapshot();
      if (t.phase !== 'work') return false;
    }
    return true;
  }

  // ---- schedules ------------------------------------------------------------

  /** Call about once a minute: starts and ends scheduled sessions. */
  tick(): void {
    const now = this.now();
    for (const [k, until] of this.allowances) if (until <= now) this.allowances.delete(k);
    for (const [k, until] of this.continuePasses) if (until <= now) this.continuePasses.delete(k);
    const active = this.settings.schedules.find((sch) => sch.enabled && scheduleActiveAt(sch, now));
    const s = this.session;
    if (s?.source === 'schedule' && s.scheduleId) {
      const sch = this.settings.schedules.find((x) => x.id === s.scheduleId);
      if (!sch || !sch.enabled || !scheduleActiveAt(sch, now)) this.endSession('schedule-ended');
      return;
    }
    if (!s && active && !this.dismissedSchedules.has(this.scheduleWindowKey(active.id, now))) {
      this.startSession({ mode: active.mode, source: 'schedule', scheduleId: active.id, timer: false });
    }
  }

  private scheduleWindowKey(scheduleId: string, at: number): string {
    const d = new Date(at);
    return `${scheduleId}@${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  // ---- navigation ------------------------------------------------------------

  /**
   * Decides what to do with a navigation. Use for main-frame requests (via the hub
   * handler) and for in-page navigations that never hit the network, such as YouTube
   * switching to a Short (Electron's did-navigate-in-page): if the result is
   * "intervene", load redirectUrl in that tab.
   */
  evaluateNavigation(url: string, ctx: { webContentsId?: number; profileId: string; isPrivate?: boolean; previousUrl?: string }, scope: 'pages' | 'embedded' = 'pages'): NavigationDecision {
    const s = this.session;
    if (!s || !this.isEnforcing()) return { kind: 'allow' };
    if (this.settings.excludedProfiles.includes(ctx.profileId)) return { kind: 'allow' };
    if (this.settings.alwaysAllowed.length && evaluateRules(url, this.settings.alwaysAllowed.map((p, i) => ({ id: `always-${i}`, pattern: p, action: 'allow' as const, scope: 'both' as const })), scope)) {
      return { kind: 'allow' };
    }
    const match = evaluateRules(url, this.settings.modes[s.mode].rules, scope);
    if (!match || match.action === 'allow') return { kind: 'allow' };
    const now = this.now();
    if ((this.allowances.get(match.rule.id) ?? 0) > now) return { kind: 'allow' };

    const site = siteOf(url);
    if (scope === 'embedded') {
      if (match.action !== 'block') return { kind: 'allow' };
      this.emit('embedded-blocked', { url, site, ruleId: match.rule.id, at: now });
      return { kind: 'cancel' };
    }
    const passKey = normaliseForPass(url);
    // A pass lasts a minute rather than one request: the shell's navigation check and
    // the network request for the same page both consult it.
    if ((this.continuePasses.get(passKey) ?? 0) > now) return { kind: 'allow' };

    const intervention: Intervention = {
      id: randomUUID(),
      sessionId: s.id,
      mode: s.mode,
      url,
      site,
      ruleId: match.rule.id,
      pattern: match.rule.pattern,
      label: match.rule.label,
      action: match.action,
      createdAt: now,
      returnUrl: this.returnUrlFor(ctx),
      goal: s.goal,
      profileId: ctx.isPrivate ? 'private' : ctx.profileId,
    };
    this.pending.set(intervention.id, intervention);
    if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    s.interventions++;
    s.interruptedSites[site] = (s.interruptedSites[site] ?? 0) + 1;
    this.emit('intervention', intervention);
    this.changed();
    return { kind: 'intervene', redirectUrl: `${this.interventionBaseUrl}?id=${encodeURIComponent(intervention.id)}`, intervention };
  }

  getIntervention(id: string): Intervention | undefined {
    return this.pending.get(id);
  }

  interventionOptions(intervention: Intervention): InterventionOptions {
    const policy: StrictnessPolicy = STRICTNESS[this.settings.modes[intervention.mode].strictness];
    return {
      continueAfterSeconds: policy.continueDelaySeconds[intervention.action],
      allowAfterSeconds: policy.allowDelaySeconds,
      allowMinutes: policy.allowOptionsMinutes,
    };
  }

  /** Applies the user's choice from the intervention screen and returns where the tab should go. */
  resolveIntervention(id: string, choice: InterventionChoice, minutes?: number): ResolveResult {
    const iv = this.pending.get(id);
    if (!iv) return { error: 'This prompt has expired.', redirect: this.newTabUrl };
    const s = this.session;
    if (choice === 'back') return this.finish(iv, choice, { redirect: iv.returnUrl }, () => s && s.returned++);
    if (choice === 'end') {
      this.finish(iv, choice, { redirect: iv.url });
      this.endSession('ended-from-intervention');
      return { redirect: iv.url };
    }
    if (!s || s.id !== iv.sessionId) return this.finish(iv, choice, { redirect: iv.url });
    const opts = this.interventionOptions(iv);
    const waited = (this.now() - iv.createdAt) / 1000;
    const self = `${this.interventionBaseUrl}?id=${encodeURIComponent(id)}`;
    if (choice === 'continue') {
      if (opts.continueAfterSeconds === null) return { error: 'Continuing is not available for blocked sites in this mode.', redirect: self };
      if (waited < opts.continueAfterSeconds) return { error: 'Please wait a moment before continuing.', redirect: self };
      this.continuePasses.set(normaliseForPass(iv.url), this.now() + CONTINUE_PASS_MS);
      return this.finish(iv, choice, { redirect: iv.url }, () => s.continued++);
    }
    if (choice === 'allow') {
      const m = minutes ?? opts.allowMinutes[0]!;
      if (!opts.allowMinutes.includes(m)) return { error: 'That duration is not available in this mode.', redirect: self };
      if (waited < opts.allowAfterSeconds) return { error: 'Please wait a moment first.', redirect: self };
      this.allowances.set(iv.ruleId, this.now() + m * 60_000);
      return this.finish(iv, choice, { redirect: iv.url }, () => s.allowed++);
    }
    return { error: 'Unknown choice.', redirect: self };
  }

  /** Request handler for the web-request hub: intercepts main frames and blocked embeds. */
  handler(opts: { isPrivate?(sessionKey: string): boolean } = {}): RequestHandler {
    return {
      name: 'focus',
      onBeforeRequest: (ctx: RequestContext) => {
        if (ctx.resourceType !== 'mainFrame' && ctx.resourceType !== 'subFrame') return;
        if (ctx.method !== 'GET') return;
        const d = this.evaluateNavigation(
          ctx.url,
          { webContentsId: ctx.webContentsId, profileId: ctx.sessionKey, isPrivate: opts.isPrivate?.(ctx.sessionKey) },
          ctx.resourceType === 'mainFrame' ? 'pages' : 'embedded',
        );
        if (d.kind === 'intervene') return { redirectURL: d.redirectUrl };
        if (d.kind === 'cancel') return { cancel: true };
      },
    };
  }

  exportState(): PersistedFocusState {
    return {
      session: this.session && { ...this.session, timer: this.timer?.toState() },
      allowances: Object.fromEntries(this.allowances),
      dismissedSchedules: [...this.dismissedSchedules].slice(-50),
    };
  }

  dispose(): void {
    this.detachTimer();
    this.clearEndTimeout();
  }

  // ---- internals ---------------------------------------------------------------

  private restore(state: PersistedFocusState): void {
    const now = this.now();
    this.allowances = new Map(Object.entries(state.allowances ?? {}).filter(([, v]) => typeof v === 'number' && v > now));
    this.dismissedSchedules = new Set(state.dismissedSchedules ?? []);
    if (state.session && this.settings.modes[state.session.mode]) {
      this.session = { ...state.session };
      if (state.session.timer) this.attachTimer(PomodoroTimer.fromState(state.session.timer, this.options.timerClock));
      if (this.timer?.snapshot().finished) {
        this.endSession('completed');
        return;
      }
      this.scheduleEnd();
    }
  }

  private finish(iv: Intervention, choice: InterventionChoice, result: ResolveResult, count?: () => unknown): ResolveResult {
    this.pending.delete(iv.id);
    count?.();
    const resolved = { ...iv, resolution: choice, resolvedAt: this.now() };
    this.emit('intervention-resolved', resolved);
    this.changed();
    return result;
  }

  private returnUrlFor(ctx: { webContentsId?: number; previousUrl?: string }): string {
    const current = ctx.previousUrl ?? (ctx.webContentsId !== undefined ? this.options.getCurrentUrl?.(ctx.webContentsId) : undefined);
    return current && !current.startsWith(this.interventionBaseUrl) && current !== 'about:blank' ? current : this.newTabUrl;
  }

  private attachTimer(timer: PomodoroTimer): void {
    this.detachTimer();
    this.timer = timer;
    this.timerOff = [
      timer.on('phase-ended', (e) => {
        if (!this.settings.notifications) return;
        const body = e.next === null ? 'All planned blocks done.' : e.next === 'work' ? 'Break over. Ready for the next block?' : 'Nice work. Time for a break.';
        this.emit('notify', { title: e.phase === 'work' ? 'Focus block complete' : 'Break finished', body });
      }),
      timer.on('finished', () => queueMicrotask(() => this.session && this.endSession('completed'))),
      timer.on('change', () => this.changed()),
    ];
  }

  private detachTimer(): void {
    for (const off of this.timerOff) off();
    this.timerOff = [];
    this.timer?.dispose();
    this.timer = undefined;
  }

  private scheduleEnd(): void {
    this.clearEndTimeout();
    const st = this.status();
    if (!this.session?.plannedMinutes || st.paused || st.remainingMs === undefined) return;
    if (st.remainingMs <= 0) {
      this.endSession('completed');
      return;
    }
    this.endTimeout = setTimeout(() => this.endSession('completed'), st.remainingMs);
  }

  private clearEndTimeout(): void {
    if (this.endTimeout) clearTimeout(this.endTimeout);
    this.endTimeout = undefined;
  }

  private changed(): void {
    this.emit('session-changed', this.status());
    this.emit('state-changed', this.exportState());
  }
}

function siteOf(url: string): string {
  try {
    return getDomain(url) ?? new URL(url).hostname;
  } catch {
    return url;
  }
}

function normaliseForPass(url: string): string {
  return url.split('#')[0]!;
}

function minutesOf(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Supports windows that cross midnight, e.g. 22:00 to 01:00. */
export function scheduleActiveAt(s: FocusSchedule, at: number): boolean {
  const d = new Date(at);
  const minute = d.getHours() * 60 + d.getMinutes();
  const start = minutesOf(s.start);
  const end = minutesOf(s.end);
  if (Number.isNaN(start) || Number.isNaN(end) || start === end) return false;
  if (start < end) return s.days.includes(d.getDay()) && minute >= start && minute < end;
  if (minute >= start) return s.days.includes(d.getDay());
  return minute < end && s.days.includes((d.getDay() + 6) % 7);
}
