import { Emitter } from './emitter.js';

export type TimerPhase = 'work' | 'short-break' | 'long-break';

export interface TimerConfig {
  workMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  /** A long break replaces every Nth short break. 0 disables long breaks. */
  longBreakEvery: number;
  /** Stop after this many work blocks. 0 runs until stopped. */
  cycles: number;
  autoStartBreaks: boolean;
  autoStartWork: boolean;
}

export const DEFAULT_TIMER: TimerConfig = {
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4,
  cycles: 0,
  autoStartBreaks: true,
  autoStartWork: false,
};

export interface TimerSnapshot {
  phase: TimerPhase;
  running: boolean;
  /** True when a phase ended and the next one waits for the user to start it. */
  waiting: boolean;
  remainingMs: number;
  phaseDurationMs: number;
  completedWorkBlocks: number;
  finished: boolean;
  config: TimerConfig;
}

export interface TimerState {
  config: TimerConfig;
  phase: TimerPhase;
  running: boolean;
  waiting: boolean;
  finished: boolean;
  /** When running: the wall-clock time the current phase will end. */
  endsAt?: number;
  /** When paused or waiting: remaining time in the phase. */
  remainingMs: number;
  completedWorkBlocks: number;
  /** Total work time actually elapsed, excluding pauses and breaks. */
  workMs: number;
  /** Start of the current running stretch, for workMs accounting. */
  runningSince?: number;
}

type TimerEvents = {
  'phase-ended': { phase: TimerPhase; next: TimerPhase | null; completedWorkBlocks: number };
  change: TimerSnapshot;
  finished: { completedWorkBlocks: number; workMs: number };
};

export interface TimerClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: TimerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Pomodoro-style timer. It schedules a single timeout for the next phase boundary
 * instead of ticking every second, and its state is plain JSON so a running timer
 * survives an app restart (see toState/fromState).
 */
export class PomodoroTimer extends Emitter<TimerEvents> {
  private state: TimerState;
  private handle: unknown;

  constructor(config: Partial<TimerConfig> = {}, private readonly clock: TimerClock = systemClock, state?: TimerState) {
    super();
    const full = validateTimerConfig({ ...DEFAULT_TIMER, ...config });
    this.state = state ?? {
      config: full,
      phase: 'work',
      running: false,
      waiting: true,
      finished: false,
      remainingMs: full.workMinutes * 60_000,
      completedWorkBlocks: 0,
      workMs: 0,
    };
    if (this.state.running) this.catchUp();
  }

  static fromState(state: TimerState, clock?: TimerClock): PomodoroTimer {
    return new PomodoroTimer(state.config, clock, structuredClone(state));
  }

  toState(): TimerState {
    return structuredClone(this.state);
  }

  start(): void {
    if (this.state.finished || this.state.running) return;
    const now = this.clock.now();
    this.state.running = true;
    this.state.waiting = false;
    this.state.endsAt = now + this.state.remainingMs;
    if (this.state.phase === 'work') this.state.runningSince = now;
    this.schedule();
    this.changed();
  }

  pause(): void {
    if (!this.state.running) return;
    const now = this.clock.now();
    this.accrueWork(now);
    this.state.remainingMs = Math.max(0, (this.state.endsAt ?? now) - now);
    this.state.running = false;
    this.state.endsAt = undefined;
    this.clear();
    this.changed();
  }

  resume(): void {
    this.start();
  }

  /** Ends the current phase now and moves to the next one. */
  skip(): void {
    if (this.state.finished) return;
    this.advance(this.clock.now(), false);
    if (this.state.running) this.schedule();
  }

  stop(): void {
    const now = this.clock.now();
    this.accrueWork(now);
    this.clear();
    this.state.running = false;
    this.state.finished = true;
    this.state.endsAt = undefined;
    this.changed();
  }

  snapshot(): TimerSnapshot {
    const now = this.clock.now();
    const s = this.state;
    return {
      phase: s.phase,
      running: s.running,
      waiting: s.waiting,
      remainingMs: s.running ? Math.max(0, (s.endsAt ?? now) - now) : s.remainingMs,
      phaseDurationMs: phaseMs(s.config, s.phase),
      completedWorkBlocks: s.completedWorkBlocks,
      finished: s.finished,
      config: s.config,
    };
  }

  /** Work time actually spent, excluding pauses and breaks. */
  workMs(): number {
    const s = this.state;
    return s.workMs + (s.running && s.phase === 'work' && s.runningSince !== undefined ? this.clock.now() - s.runningSince : 0);
  }

  dispose(): void {
    this.clear();
  }

  /** Processes any phase boundaries that passed while the app was closed or asleep. */
  private catchUp(): void {
    let guard = 0;
    while (this.state.running && this.state.endsAt !== undefined && this.state.endsAt <= this.clock.now() && guard++ < 1000) {
      this.advance(this.state.endsAt, true);
    }
    if (this.state.running) this.schedule();
  }

  private advance(at: number, natural: boolean): void {
    const s = this.state;
    this.clear();
    this.accrueWork(at);
    const ended = s.phase;
    if (ended === 'work' && natural) s.completedWorkBlocks++;
    const finished = ended === 'work' && s.config.cycles > 0 && s.completedWorkBlocks >= s.config.cycles;
    const next: TimerPhase | null = finished ? null : this.nextPhase(ended);
    this.emit('phase-ended', { phase: ended, next, completedWorkBlocks: s.completedWorkBlocks });
    if (!next) {
      s.running = false;
      s.finished = true;
      s.endsAt = undefined;
      s.remainingMs = 0;
      this.emit('finished', { completedWorkBlocks: s.completedWorkBlocks, workMs: s.workMs });
      this.changed();
      return;
    }
    s.phase = next;
    s.remainingMs = phaseMs(s.config, next);
    const autoStart = next === 'work' ? s.config.autoStartWork : s.config.autoStartBreaks;
    const keepRunning = s.running && autoStart;
    s.running = keepRunning;
    s.waiting = !keepRunning;
    s.endsAt = keepRunning ? at + s.remainingMs : undefined;
    s.runningSince = keepRunning && next === 'work' ? at : undefined;
    this.changed();
  }

  private nextPhase(ended: TimerPhase): TimerPhase {
    if (ended !== 'work') return 'work';
    const every = this.state.config.longBreakEvery;
    return every > 0 && this.state.completedWorkBlocks > 0 && this.state.completedWorkBlocks % every === 0 ? 'long-break' : 'short-break';
  }

  private accrueWork(now: number): void {
    const s = this.state;
    if (s.running && s.phase === 'work' && s.runningSince !== undefined) {
      s.workMs += Math.max(0, now - s.runningSince);
      s.runningSince = now;
    }
  }

  private schedule(): void {
    this.clear();
    const endsAt = this.state.endsAt;
    if (endsAt === undefined) return;
    this.handle = this.clock.setTimeout(() => {
      this.handle = undefined;
      this.catchUp();
    }, Math.max(0, endsAt - this.clock.now()));
  }

  private clear(): void {
    if (this.handle !== undefined) this.clock.clearTimeout(this.handle);
    this.handle = undefined;
  }

  private changed(): void {
    this.emit('change', this.snapshot());
  }
}

function phaseMs(c: TimerConfig, p: TimerPhase): number {
  const minutes = p === 'work' ? c.workMinutes : p === 'short-break' ? c.shortBreakMinutes : c.longBreakMinutes;
  return Math.round(minutes * 60_000);
}

export function validateTimerConfig(c: TimerConfig): TimerConfig {
  const clamp = (v: unknown, min: number, max: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
  return {
    workMinutes: clamp(c.workMinutes, 1, 240, DEFAULT_TIMER.workMinutes),
    shortBreakMinutes: clamp(c.shortBreakMinutes, 1, 60, DEFAULT_TIMER.shortBreakMinutes),
    longBreakMinutes: clamp(c.longBreakMinutes, 1, 120, DEFAULT_TIMER.longBreakMinutes),
    longBreakEvery: Math.round(clamp(c.longBreakEvery, 0, 12, DEFAULT_TIMER.longBreakEvery)),
    cycles: Math.round(clamp(c.cycles, 0, 50, DEFAULT_TIMER.cycles)),
    autoStartBreaks: typeof c.autoStartBreaks === 'boolean' ? c.autoStartBreaks : DEFAULT_TIMER.autoStartBreaks,
    autoStartWork: typeof c.autoStartWork === 'boolean' ? c.autoStartWork : DEFAULT_TIMER.autoStartWork,
  };
}
