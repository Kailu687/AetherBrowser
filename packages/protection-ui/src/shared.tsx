import { useCallback, useEffect, useRef, useState } from 'react';
import type { PanelApi } from '@aether/plugin-api';

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (ms > 0 && min === 0) return '<1m';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function timeAgo(t: number | undefined): string {
  if (!t) return 'never';
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** Loads data from the module and reloads on demand; errors become a message instead of a crash. */
export function useInvoke<T>(api: PanelApi, method: string, payload: unknown, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    api
      .invoke<T>(method, payload)
      .then((d) => {
        if (n === seq.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => n === seq.current && setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, reload, setData };
}

/** A button that asks for a second click before doing something destructive. */
export function ConfirmButton({ label, confirmLabel, onConfirm }: { label: string; confirmLabel: string; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      className="btn small"
      style={armed ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : undefined}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <p className="small" style={{ color: 'var(--danger)' }}>{error}</p> : null;
}

export const row: React.CSSProperties = { display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 };
/** Checkboxes and radios inside the shell's column-style settings labels. */
export const check: React.CSSProperties = { width: 'auto', flex: 'none', margin: 0 };
export const stack: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };
export const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 12 };
