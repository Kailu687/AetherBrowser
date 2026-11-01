import type { PanelApi } from '@aether/plugin-api';
import { ConfirmButton, ErrorNote, card, check, formatDuration, row, stack, useInvoke } from './shared';

interface Report {
  totals: { active: number; passive: number; media: number };
  learningMs: number;
  leisureMs: number;
  byDomain: { domain: string; active: number }[];
  focusSessions: unknown[];
  focusedMs: number;
  interrupters: { domain: string; attempts: number }[];
}
interface Settings { enabled: boolean; pausedUntil: number | null; excludedDomains: string[]; retentionDays: number; [k: string]: unknown }

export function TimePanel({ api }: { api: PanelApi }) {
  const { data: r, error, reload } = useInvoke<Report>(api, 'activity.report', { range: 'today' }, [api]);
  const { data: s, reload: reloadSettings } = useInvoke<Settings>(api, 'activity.getSettings', {}, [api]);
  const refresh = () => {
    reload();
    reloadSettings();
  };
  const call = (m: string, p: unknown = {}) => void api.invoke(m, p).then(refresh).catch(refresh);

  if (!r || !s) return error ? <ErrorNote error={error} /> : <p className="muted small">Loading…</p>;
  const paused = !!s.pausedUntil && s.pausedUntil > Date.now();
  const max = Math.max(1, ...r.byDomain.map((d) => d.active));
  const site = (() => {
    try {
      return /^https?:/.test(api.activeTab.url) ? new URL(api.activeTab.url).hostname.replace(/^www\./, '') : '';
    } catch {
      return '';
    }
  })();

  return (
    <div className="settings" style={stack}>
      {(!s.enabled || paused) && <p className="small" style={{ ...card, margin: 0 }}>{!s.enabled ? 'Time tracking is off.' : 'Time tracking is paused.'}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Stat label="Active today" value={formatDuration(r.totals.active)} />
        <Stat label="Learning & research" value={formatDuration(r.learningMs)} />
        <Stat label="Entertainment & social" value={formatDuration(r.leisureMs)} />
        <Stat label="Focused" value={r.focusSessions.length ? formatDuration(r.focusedMs) : '—'} />
      </div>
      {r.byDomain.length > 0 && (
        <>
          <h4>Top sites today</h4>
          <div>
            {r.byDomain.slice(0, 6).map((d) => (
              <div key={d.domain} className="list-row" style={{ display: 'grid', gridTemplateColumns: '1fr 70px 52px', gap: 8 }}>
                <span className="ellipsis small">{d.domain}</span>
                <span style={{ height: 6, borderRadius: 3, background: 'var(--accent)', width: `${(d.active / max) * 100}%`, alignSelf: 'center' }} />
                <span className="small muted" style={{ textAlign: 'right' }}>{formatDuration(d.active)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {r.interrupters.length > 0 && (
        <p className="small muted" style={{ margin: 0 }}>
          Pulled away most by {r.interrupters.slice(0, 3).map((i) => `${i.domain} (${i.attempts})`).join(', ')}.
        </p>
      )}
      <button className="btn small primary" onClick={() => api.openUrl('aether://activity/?range=week')}>Open weekly dashboard</button>

      <h4>Tracking</h4>
      <div style={{ ...row, flexWrap: 'wrap' }}>
        {paused ? (
          <button className="btn small" onClick={() => call('activity.resume')}>Resume tracking</button>
        ) : (
          <>
            <button className="btn small" onClick={() => call('activity.pause', { minutes: 60 })}>Pause 1 hour</button>
            <button className="btn small" onClick={() => call('activity.pause', {})}>Pause until resumed</button>
          </>
        )}
        <label className="small" style={row}>
          <input type="checkbox" style={check} checked={s.enabled} onChange={(e) => call('activity.setSettings', { settings: { ...s, enabled: e.target.checked } })} />
          Track time on this device
        </label>
      </div>
      {site && !s.excludedDomains.includes(site) && (
        <div>
          <button className="btn small" onClick={() => call('activity.setSettings', { settings: { ...s, excludedDomains: [...s.excludedDomains, site] } })}>Never track {site}</button>
        </div>
      )}
      {s.excludedDomains.length > 0 && (
        <div>
          {s.excludedDomains.map((d) => (
            <div key={d} className="list-row">
              <span className="grow small">Not tracked: {d}</span>
              <button className="icon-btn small" title="Track again" onClick={() => call('activity.setSettings', { settings: { ...s, excludedDomains: s.excludedDomains.filter((x) => x !== d) } })}>×</button>
            </div>
          ))}
        </div>
      )}
      <label>
        Keep history for
        <select value={s.retentionDays} onChange={(e) => call('activity.setSettings', { settings: { ...s, retentionDays: Number(e.target.value) } })}>
          <option value={7}>1 week</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
          <option value={365}>1 year</option>
          <option value={0}>Forever</option>
        </select>
      </label>
      <div style={{ ...row, flexWrap: 'wrap' }}>
        <ConfirmButton label="Delete today" confirmLabel="Click again to delete today" onConfirm={() => {
          const d = new Date();
          const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
          call('activity.deleteRange', { from, to: from + 86_400_000 });
        }} />
        <ConfirmButton label="Delete all history" confirmLabel="Click again to delete everything" onConfirm={() => call('activity.deleteAll')} />
      </div>
      <p className="small muted">Stored only on this device. Only site names are kept, never full addresses, page content or keystrokes. Private windows are never counted.</p>
      <ErrorNote error={error} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ ...card, padding: '8px 10px' }}>
      <div className="small muted">{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
