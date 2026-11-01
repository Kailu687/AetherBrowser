import { useEffect, useState } from 'react';
import type { PanelApi } from '@aether/plugin-api';
import { ErrorNote, card, formatClock, row, stack, useInvoke } from './shared';

type Mode = 'deep-work' | 'study' | 'research' | 'relaxed' | 'custom';
type Action = 'allow' | 'warn' | 'block';
interface Rule { id: string; pattern: string; action: Action; scope?: string }
interface ModeConfig { label: string; description: string; rules: Rule[]; strictness: 'gentle' | 'balanced' | 'strict' }
interface Settings { modes: Record<Mode, ModeConfig>; alwaysAllowed: string[]; [k: string]: unknown }
interface Status {
  active: boolean;
  paused: boolean;
  enforcing: boolean;
  elapsedMs: number;
  remainingMs?: number;
  session?: { mode: Mode; goal: string; interventions: number; plannedMinutes?: number };
  modeConfig?: ModeConfig;
  timer?: { phase: 'work' | 'short-break' | 'long-break'; running: boolean; waiting: boolean; remainingMs: number; completedWorkBlocks: number };
}

const LENGTHS = [
  { id: 'p25', label: 'Pomodoro 25 / 5', timer: { workMinutes: 25, shortBreakMinutes: 5 } },
  { id: 'p50', label: 'Long blocks 50 / 10', timer: { workMinutes: 50, shortBreakMinutes: 10 } },
  { id: 't30', label: '30 minutes', planned: 30 },
  { id: 't60', label: '1 hour', planned: 60 },
  { id: 't90', label: '90 minutes', planned: 90 },
  { id: 'open', label: 'Until I stop it' },
] as const;

const ACTION_LABEL: Record<Action, string> = { allow: 'Allow', warn: 'Ask first', block: 'Pause site' };

export function FocusPanel({ api }: { api: PanelApi }) {
  const { data: status, error, reload, setData } = useInvoke<Status>(api, 'focus.status', {}, [api]);
  const { data: settings, reload: reloadSettings } = useInvoke<Settings>(api, 'focus.getSettings', {}, [api]);
  const [, tick] = useState(0);
  const [mode, setMode] = useState<Mode>('study');
  const [goal, setGoal] = useState('');
  const [length, setLength] = useState<(typeof LENGTHS)[number]['id']>('p25');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => api.on('focus-changed', (s) => setData(s as Status)), [api, setData]);
  useEffect(() => {
    if (!status?.active || status.paused) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    // Re-sync with the main process occasionally; the local tick only animates.
    const sync = setInterval(reload, 30_000);
    return () => {
      clearInterval(t);
      clearInterval(sync);
    };
  }, [status?.active, status?.paused, reload]);

  const run = (method: string, payload: unknown = {}) => {
    setBusy(method);
    void api
      .invoke<Status>(method, payload)
      .then(() => reload())
      .finally(() => setBusy(null));
  };

  if (!status || !settings) return error ? <ErrorNote error={error} /> : <p className="muted small">Loading…</p>;

  if (status.active && status.session) {
    const t = status.timer;
    const remaining = (t ? t.remainingMs : status.remainingMs) ?? undefined;
    const phase = t ? (t.phase === 'work' ? 'Focus block' : t.phase === 'long-break' ? 'Long break' : 'Break') : status.session.plannedMinutes ? 'Remaining' : 'Focused for';
    return (
      <div className="settings" style={stack}>
        <div style={{ ...card, textAlign: 'center' }}>
          <div className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>
            {status.modeConfig?.label} · {phase}
          </div>
          <div style={{ fontSize: 40, fontWeight: 600, fontVariantNumeric: 'tabular-nums', margin: '6px 0' }}>
            <LiveClock base={remaining ?? status.elapsedMs} direction={remaining !== undefined ? -1 : 1} running={!status.paused && (!t || t.running)} key={`${remaining}-${status.elapsedMs}`} />
          </div>
          {status.session.goal && <div style={{ marginBottom: 4 }}>{status.session.goal}</div>}
          <div className="small muted">
            {status.paused ? 'Paused. Sites are not restricted while paused.' : !status.enforcing ? (t && t.phase !== 'work' ? 'On a break. Sites are open.' : 'Rules start in a moment.') : 'Rules are on.'}
            {t ? ` · ${t.completedWorkBlocks} block${t.completedWorkBlocks === 1 ? '' : 's'} done` : ''}
            {status.session.interventions ? ` · ${status.session.interventions} prompt${status.session.interventions === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        <div style={{ ...row, flexWrap: 'wrap' }}>
          {t?.waiting && (
            <button className="btn small primary" disabled={!!busy} onClick={() => run('focus.startNextPhase')}>
              {t.phase === 'work' ? 'Start next block' : 'Start break'}
            </button>
          )}
          {status.paused ? (
            <button className="btn small primary" disabled={!!busy} onClick={() => run('focus.resume')}>Resume</button>
          ) : (
            <button className="btn small" disabled={!!busy} onClick={() => run('focus.pause')}>Pause</button>
          )}
          {t && !t.waiting && <button className="btn small" disabled={!!busy} onClick={() => run('focus.skipPhase')}>{t.phase === 'work' ? 'Take break now' : 'Skip break'}</button>}
          <button className="btn small" disabled={!!busy} onClick={() => run('focus.end')}>End session</button>
        </div>
        <p className="small muted">Ending a session is always one click away. Your session summary appears in Time.</p>
      </div>
    );
  }

  const modes = (['study', 'deep-work', 'research', 'custom'] as const).map((id) => ({ id, ...settings.modes[id] }));
  const selected = settings.modes[mode];
  const start = () => {
    const l = LENGTHS.find((x) => x.id === length)!;
    run('focus.start', { mode, goal: goal.trim(), timer: 'timer' in l ? l.timer : false, plannedMinutes: 'planned' in l ? l.planned : undefined });
  };
  const saveRules = (rules: Rule[], extra: Partial<ModeConfig> = {}) =>
    void api
      .invoke('focus.setSettings', { settings: { ...settings, modes: { ...settings.modes, [mode]: { ...selected, ...extra, rules } } } })
      .then(reloadSettings);

  return (
    <div className="settings" style={stack}>
      <div style={stack}>
        {modes.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            style={{ ...card, textAlign: 'left', cursor: 'pointer', borderColor: mode === m.id ? 'var(--accent)' : 'var(--line)', padding: '8px 12px' }}
          >
            <b>{m.label}</b>
            <div className="small muted">{m.description}</div>
          </button>
        ))}
      </div>
      <label>
        <span>What are you working on? <span className="muted">(optional)</span></span>
        <input value={goal} maxLength={200} placeholder="e.g. Finish the VLSI lab report" onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && start()} />
      </label>
      <label>
        Session length
        <select value={length} onChange={(e) => setLength(e.target.value as typeof length)}>
          {LENGTHS.map((l) => (
            <option key={l.id} value={l.id}>{l.label}</option>
          ))}
        </select>
      </label>
      <button className="btn primary" disabled={!!busy} onClick={start}>Start {selected.label}</button>

      <button className="btn small" onClick={() => setEditing((v) => !v)}>{editing ? 'Hide' : 'Edit'} {selected.label} rules ({selected.rules.length})</button>
      {editing && <RuleEditor config={selected} onChange={saveRules} />}
      <ErrorNote error={error} />
    </div>
  );
}

function LiveClock({ base, direction, running }: { base: number; direction: 1 | -1; running: boolean }) {
  const [start] = useState(() => Date.now());
  const [, force] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running]);
  const delta = running ? Date.now() - start : 0;
  return <>{formatClock(base + direction * delta)}</>;
}

function RuleEditor({ config, onChange }: { config: ModeConfig; onChange: (rules: Rule[], extra?: Partial<ModeConfig>) => void }) {
  const [pattern, setPattern] = useState('');
  const [action, setAction] = useState<Action>('warn');
  const valid = /^([a-z0-9-]+\.)+[a-z0-9-]+(\/\S*)?$/i.test(pattern.trim().replace(/^https?:\/\//, '').replace(/^www\./, ''));
  const add = () => {
    if (!valid) return;
    onChange([...config.rules, { id: `user-${Date.now().toString(36)}`, pattern: pattern.trim(), action }]);
    setPattern('');
  };
  return (
    <div style={stack}>
      <p className="small muted" style={{ margin: 0 }}>
        Use a site (<code>reddit.com</code>) or part of one (<code>youtube.com/shorts</code>). The most specific rule wins.
      </p>
      <div style={row}>
        <input className="grow" value={pattern} placeholder="instagram.com/reels" onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <select value={action} onChange={(e) => setAction(e.target.value as Action)}>
          {(['warn', 'block', 'allow'] as const).map((a) => (
            <option key={a} value={a}>{ACTION_LABEL[a]}</option>
          ))}
        </select>
        <button className="btn small" disabled={!valid} onClick={add}>Add</button>
      </div>
      <div>
        {config.rules.map((r) => (
          <div key={r.id} className="list-row">
            <span className="grow ellipsis small">{r.pattern}</span>
            <span className={`pill ${r.action === 'allow' ? 'allow' : r.action === 'block' ? 'deny' : ''}`}>{ACTION_LABEL[r.action]}</span>
            <button className="icon-btn small" title="Remove rule" onClick={() => onChange(config.rules.filter((x) => x.id !== r.id))}>×</button>
          </div>
        ))}
        {!config.rules.length && <p className="small muted">No rules: every site stays open.</p>}
      </div>
      <label>
        Strictness
        <select value={config.strictness} onChange={(e) => onChange(config.rules, { strictness: e.target.value as ModeConfig['strictness'] })}>
          <option value="gentle">Gentle: all options right away</option>
          <option value="balanced">Balanced: a short pause before continuing</option>
          <option value="strict">Strict: paused sites stay paused, short allowances only</option>
        </select>
      </label>
    </div>
  );
}


