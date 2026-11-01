import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PomodoroTimer, validateTimerConfig, DEFAULT_TIMER } from '../src/index.js';

const MIN = 60_000;

describe('PomodoroTimer', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }));
  afterEach(() => vi.useRealTimers());

  it('runs work and break phases with a long break every N blocks', () => {
    const t = new PomodoroTimer({ workMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, longBreakEvery: 2, autoStartWork: true });
    const phases: string[] = [];
    t.on('phase-ended', (e) => phases.push(`${e.phase}->${e.next}`));
    t.start();
    vi.advanceTimersByTime(25 * MIN);
    expect(t.snapshot()).toMatchObject({ phase: 'short-break', running: true, completedWorkBlocks: 1 });
    vi.advanceTimersByTime(5 * MIN + 25 * MIN);
    expect(t.snapshot().phase).toBe('long-break');
    expect(phases).toEqual(['work->short-break', 'short-break->work', 'work->long-break']);
    expect(t.workMs()).toBe(50 * MIN);
  });

  it('waits for the user before the next work block when auto-start is off', () => {
    const t = new PomodoroTimer({ workMinutes: 1, shortBreakMinutes: 1 });
    t.start();
    vi.advanceTimersByTime(2 * MIN);
    expect(t.snapshot()).toMatchObject({ phase: 'work', running: false, waiting: true, remainingMs: MIN });
    t.start();
    vi.advanceTimersByTime(30_000);
    expect(t.snapshot().remainingMs).toBe(30_000);
  });

  it('pauses and resumes without losing time, and pauses do not count as work', () => {
    const t = new PomodoroTimer({ workMinutes: 10 });
    t.start();
    vi.advanceTimersByTime(4 * MIN);
    t.pause();
    vi.advanceTimersByTime(30 * MIN);
    expect(t.snapshot()).toMatchObject({ phase: 'work', running: false, remainingMs: 6 * MIN });
    t.resume();
    vi.advanceTimersByTime(6 * MIN);
    expect(t.snapshot().phase).toBe('short-break');
    expect(t.workMs()).toBe(10 * MIN);
  });

  it('finishes after the configured number of cycles', () => {
    const t = new PomodoroTimer({ workMinutes: 1, shortBreakMinutes: 1, cycles: 2, autoStartWork: true });
    const done = vi.fn();
    t.on('finished', done);
    t.start();
    vi.advanceTimersByTime(3 * MIN);
    expect(done).toHaveBeenCalledWith({ completedWorkBlocks: 2, workMs: 2 * MIN });
    expect(t.snapshot().finished).toBe(true);
  });

  it('skips the current phase without counting it as completed', () => {
    const t = new PomodoroTimer();
    t.start();
    t.skip();
    expect(t.snapshot()).toMatchObject({ phase: 'short-break', completedWorkBlocks: 0, running: true });
  });

  it('restores from saved state and catches up on time that passed while closed', () => {
    const t = new PomodoroTimer({ workMinutes: 25, shortBreakMinutes: 5, autoStartWork: true });
    t.start();
    vi.advanceTimersByTime(10 * MIN);
    const saved = JSON.parse(JSON.stringify(t.toState()));
    t.dispose();
    vi.setSystemTime(40 * MIN);
    const restored = PomodoroTimer.fromState(saved);
    expect(restored.snapshot()).toMatchObject({ phase: 'work', completedWorkBlocks: 1, remainingMs: 15 * MIN });
  });

  it('clamps invalid configuration', () => {
    expect(validateTimerConfig({ ...DEFAULT_TIMER, workMinutes: -5, longBreakEvery: NaN, cycles: 999 })).toMatchObject({ workMinutes: 1, longBreakEvery: 4, cycles: 50 });
  });
});
