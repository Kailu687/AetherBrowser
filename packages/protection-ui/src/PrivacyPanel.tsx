import { useEffect, useMemo } from 'react';
import type { PanelApi } from '@aether/plugin-api';
import { ErrorNote, card, check, row, stack, timeAgo, useInvoke } from './shared';

interface PanelState {
  tabId: number | null;
  isPrivate: boolean;
  enabled: boolean;
  preset: 'balanced' | 'strict' | 'custom';
  site: string;
  exception: { disableBlocking?: boolean; allowThirdPartyCookies?: boolean; disableHttpsUpgrade?: boolean; disableScriptlets?: boolean; disableCosmetics?: boolean };
  blockingActive: boolean;
  engine: { state: string; updatedAt?: number; networkFilterCount: number; lists: { name: string; ok: boolean; error?: string }[] };
  tab?: { blocked: number; cookiesStripped: number; upgradedToHttps: boolean; trackingParamsRemoved: boolean; recent: { host: string; resourceType: string }[] };
}

const PRESETS = [
  { id: 'balanced', label: 'Balanced', hint: 'Blocks ads and trackers. Keeps sign-ins and embeds working.' },
  { id: 'strict', label: 'Strict', hint: 'Also blocks third-party cookies and annoyances, and upgrades to HTTPS. A few sites may break.' },
] as const;

export function PrivacyPanel({ api }: { api: PanelApi }) {
  const tabId = api.activeTab.tabId;
  const { data: s, error, reload } = useInvoke<PanelState>(api, 'privacy.panel', { tabId: tabId ?? undefined }, [api, tabId, api.activeTab.url]);
  useEffect(() => api.on('privacy-changed', (p) => (p as { tabId: number }).tabId === tabId && reload()), [api, tabId, reload]);

  const hosts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of s?.tab?.recent ?? []) counts.set(r.host, (counts.get(r.host) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [s?.tab?.recent]);

  const act = (method: string, payload: unknown) => void api.invoke(method, payload).then(reload).catch(reload);
  if (!s) return error ? <ErrorNote error={error} /> : <p className="muted small">Loading…</p>;
  const isWeb = /^https?:/.test(api.activeTab.url);
  const blocked = s.tab?.blocked ?? 0;

  return (
    <div className="settings" style={stack}>
      <div style={card}>
        {!s.enabled ? (
          <p style={{ margin: 0 }}>Protection is off for this profile.</p>
        ) : !isWeb ? (
          <p className="muted" style={{ margin: 0 }}>Open a website to see what was blocked on it.</p>
        ) : (
          <>
            <div style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.1 }}>{blocked}</div>
            <div className="muted">
              {blocked === 1 ? 'request' : 'requests'} blocked on <b style={{ color: 'var(--fg)' }}>{s.site}</b>
            </div>
            {!s.blockingActive && <p className="small" style={{ color: 'var(--danger)', marginBottom: 0 }}>Blocking is turned off for this site.</p>}
            <div className="small muted" style={{ marginTop: 6 }}>
              {[s.tab?.cookiesStripped ? `${s.tab.cookiesStripped} third-party cookies withheld` : '', s.tab?.upgradedToHttps ? 'upgraded to HTTPS' : '', s.tab?.trackingParamsRemoved ? 'tracking parameters removed from the link' : '']
                .filter(Boolean)
                .join(' · ')}
            </div>
          </>
        )}
      </div>

      {s.enabled && isWeb && (
        <div style={{ ...row, flexWrap: 'wrap' }}>
          <button className="btn small" onClick={() => act('privacy.setSiteException', { exception: { ...s.exception, disableBlocking: !s.exception.disableBlocking } })}>
            {s.exception.disableBlocking ? `Turn protection back on for ${s.site}` : `Site broken? Turn off for ${s.site}`}
          </button>
          {!s.exception.disableBlocking && (
            <>
              <label className="small" style={{ ...row, gap: 6 }}>
                <input type="checkbox" style={check} checked={!!s.exception.disableScriptlets} onChange={(e) => act('privacy.setSiteException', { exception: { ...s.exception, disableScriptlets: e.target.checked } })} />
                Turn off ad-block scripts here (keeps request blocking)
              </label>
              <label className="small" style={{ ...row, gap: 6 }}>
                <input type="checkbox" style={check} checked={!!s.exception.disableCosmetics} onChange={(e) => act('privacy.setSiteException', { exception: { ...s.exception, disableCosmetics: e.target.checked } })} />
                Turn off element hiding here
              </label>
            </>
          )}
          {s.preset !== 'balanced' && (
            <label className="small" style={{ ...row, gap: 6 }}>
              <input type="checkbox" style={check} checked={!!s.exception.allowThirdPartyCookies} onChange={(e) => act('privacy.setSiteException', { exception: { ...s.exception, allowThirdPartyCookies: e.target.checked } })} />
              Allow third-party cookies here (fixes some sign-ins)
            </label>
          )}
        </div>
      )}

      {hosts.length > 0 && (
        <>
          <h4>Blocked on this page</h4>
          <div>
            {hosts.map(([host, n]) => (
              <div key={host} className="list-row">
                <span className="grow ellipsis small">{host}</span>
                <span className="small muted">{n}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <h4>Protection level{s.isPrivate ? ' (this private window)' : ''}</h4>
      <div style={stack}>
        {PRESETS.map((p) => (
          <label key={p.id} className="small" style={{ ...row, alignItems: 'flex-start', cursor: 'pointer' }}>
            <input type="radio" name="preset" checked={s.preset === p.id} onChange={() => act('privacy.setPreset', { preset: p.id })} style={{ ...check, marginTop: 3 }} />
            <span>
              <b>{p.label}</b>
              <br />
              <span className="muted">{p.hint}</span>
            </span>
          </label>
        ))}
        {s.preset === 'custom' && <p className="small muted">Custom settings are in use.</p>}
        <label className="small" style={row}>
          <input type="checkbox" style={check} checked={s.enabled} onChange={(e) => act('privacy.setEnabled', { enabled: e.target.checked })} />
          Block ads and trackers in this profile
        </label>
      </div>

      <h4>Filter lists</h4>
      <p className="small muted" style={{ margin: 0 }}>
        {s.engine.state === 'ready' && `Up to date, ${s.engine.networkFilterCount.toLocaleString()} rules, updated ${timeAgo(s.engine.updatedAt)}.`}
        {s.engine.state === 'degraded' && `Some lists could not be downloaded (${s.engine.lists.filter((l) => !l.ok).map((l) => l.name).join(', ')}). The rest are active.`}
        {s.engine.state === 'unavailable' && 'Lists could not be downloaded, so nothing is being blocked yet. Check your connection and try again.'}
        {(s.engine.state === 'loading' || s.engine.state === 'idle') && 'Loading lists…'}
      </p>
      <div>
        <button className="btn small" onClick={() => act('privacy.refreshLists', {})}>
          Update lists now
        </button>
      </div>
      <ErrorNote error={error} />
      <p className="small muted">
        Counts only include requests AETHER actually blocked. Blocking reduces tracking; it does not make you anonymous to websites, your network or your university.
      </p>
    </div>
  );
}
