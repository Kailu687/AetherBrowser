import { useEffect, useState } from 'react';
import type { WindowState } from '../../shared/types';
import { call, send } from '../api';
import { Icon } from '../components/Icon';
import { THEMES, resolveTheme } from '../../shared/themes';

interface Settings {
  sleepAfterMinutes: number;
  permissions: { origin: string; permission: string; decision: 'allow' | 'deny' }[];
}

export function SettingsPanel({ state }: { state: WindowState }) {
  const [s, setS] = useState<Settings | null>(null);
  const load = () => void call<Settings>('settings:get').then(setS);
  useEffect(load, [state.profile.id]);
  if (!s) return null;
  return (
    <div className="settings">
      <h4>Theme</h4>
      <ThemeGallery current={state.themeId} />

      <h4>Appearance</h4>
      <label className="check">
        <input type="checkbox" checked={state.bookmarksBar} onChange={() => send('bookmarks:bar-toggle')} /> Show bookmarks bar (Ctrl+Shift+B)
      </label>

      {!state.isPrivate && <ExtensionsSection />}

      <h4>Memory saver</h4>
      <label>
        Put background tabs to sleep after
        <select value={s.sleepAfterMinutes} onChange={(e) => void call('settings:set', { sleepAfterMinutes: Number(e.target.value) }).then(load)}>
          <option value={5}>5 minutes</option>
          <option value={10}>10 minutes</option>
          <option value={20}>20 minutes</option>
          <option value={60}>1 hour</option>
          <option value={240}>4 hours</option>
          <option value={0}>Never</option>
        </select>
      </label>
      <p className="small muted">Sleeping tabs keep their place and reload when you click them. Tabs playing audio are never put to sleep. Restored sessions also load tabs only when you open them.</p>

      <h4>Site permissions ({state.isPrivate ? 'private window' : state.profile.name})</h4>
      {!s.permissions.length && <p className="small muted">No remembered decisions.</p>}
      {s.permissions.map((p) => (
        <div key={`${p.origin}-${p.permission}`} className="list-row">
          <span className="grow ellipsis small">
            {p.origin.replace(/^https?:\/\//, '')} · {p.permission}
          </span>
          <span className={`pill ${p.decision}`}>{p.decision}</span>
          <button className="icon-btn small" title="Forget" onClick={() => void call('settings:set', { clearPermission: { origin: p.origin, permission: p.permission } }).then(load)}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}

      <h4>Privacy</h4>
      <p className="small muted">
        Each profile has its own cookies, sign-ins, cache and site storage on this device. AETHER sends no telemetry and needs no account. Websites, your network and your search engine can still see what you do on them.
      </p>
      <button className="btn small" onClick={() => send('tab:new', { url: 'aether://about' })}>
        About AETHER
      </button>
    </div>
  );
}

function ThemePreview({ id }: { id: string }) {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const t = resolveTheme(id, dark).tokens;
  return (
    <div className="theme-preview" style={{ background: t.bg }}>
      <div className="tp-bar" style={{ background: t.chrome }}>
        <span className="tp-dot" style={{ background: t.accent }} />
        <span className="tp-dot" style={{ background: t.accent2 }} />
        <span className="tp-dot" style={{ background: t.muted, width: 22 }} />
      </div>
      <div style={{ background: `linear-gradient(90deg, ${t.surface} 0 60%, ${t.bg} 60%)` }} />
    </div>
  );
}

export function ThemeGallery({ current }: { current: string }) {
  const options = [{ id: 'system', name: 'Match system', tagline: 'AETHER when Windows is dark, Daylight when light' }, ...Object.values(THEMES)];
  return (
    <div className="theme-grid">
      {options.map((t) => (
        <button key={t.id} className={`theme-card ${current === t.id ? 'on' : ''}`} title={t.tagline} onClick={() => send('theme:set', t.id)}>
          <ThemePreview id={t.id} />
          <span className="strong small">{t.name}</span>
        </button>
      ))}
    </div>
  );
}

interface Ext {
  id: string;
  name: string;
  version: string;
  path: string;
}

function ExtensionsSection() {
  const [list, setList] = useState<Ext[]>([]);
  const [error, setError] = useState('');
  const load = () => void call<Ext[]>('extensions:list').then(setList);
  useEffect(load, []);
  return (
    <>
      <h4>Extensions (experimental)</h4>
      <p className="small muted">
        Load an unpacked Chrome extension folder into this profile. Content scripts and background workers work; toolbar popups and some Chrome APIs are not supported yet, so many extensions only partly work.
      </p>
      {list.map((e) => (
        <div key={e.id} className="list-row">
          <span className="grow ellipsis" title={e.path}>
            {e.name} <span className="muted small">{e.version}</span>
          </span>
          <button className="btn small" onClick={() => void call('extensions:remove', e.id).then(load)}>
            Remove
          </button>
        </div>
      ))}
      <button
        className="btn small"
        onClick={() =>
          void call('extensions:add')
            .then(() => (setError(''), load()))
            .catch((err: unknown) => setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)))
        }
      >
        Load unpacked extension…
      </button>
      {error && <p className="small" style={{ color: 'var(--danger)' }}>{error}</p>}
    </>
  );
}

