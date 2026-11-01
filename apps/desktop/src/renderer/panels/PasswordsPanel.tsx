import { useEffect, useState } from 'react';
import type { WindowState } from '../../shared/types';
import { call } from '../api';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toasts';

interface Login {
  id: number;
  origin: string;
  domain: string;
  username: string;
  title: string;
  note: string;
  source: string;
  matchesActive: boolean;
}

interface ImportResult {
  added: number;
  updated: number;
  unchanged: number;
  skipped: { line: number; reason: string }[];
  file: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));

export function PasswordsPanel({ state }: { state: WindowState }) {
  const [items, setItems] = useState<Login[]>([]);
  const [total, setTotal] = useState(0);
  const [available, setAvailable] = useState(true);
  const [q, setQ] = useState('');
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [adding, setAdding] = useState(false);
  const [wizard, setWizard] = useState(false);
  const [lastImport, setLastImport] = useState<ImportResult | null>(null);
  const active = state.tabs.find((t) => t.id === state.activeTabId);

  const load = () =>
    void call<{ available: boolean; items: Login[]; total: number }>('passwords:list', q || undefined).then((r) => {
      setItems(r.items);
      setTotal(r.total);
      setAvailable(r.available);
    });
  useEffect(load, [q, state.profile.id, active?.url, state.savedLogins]);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
    } catch (e) {
      toast(errText(e), 'error');
    }
  };

  const runImport = () =>
    act(async () => {
      const r = await call<ImportResult | null>('passwords:import');
      if (!r) return;
      setLastImport(r);
      setWizard(false);
      load();
    });

  if (state.isPrivate) return <p className="muted">Saved passwords are not available in private windows, and nothing you type here is saved.</p>;
  if (!available) return <p className="muted">This system has no OS-level encryption available, so AETHER will not store passwords rather than store them unprotected.</p>;

  const row = (l: Login) => (
    <div key={l.id} className={`login-row ${l.matchesActive ? 'here' : ''}`}>
      <div className="grow ellipsis">
        <div className="ellipsis" title={l.origin}>
          <strong>{l.title || l.domain}</strong>
        </div>
        <div className="muted small ellipsis">{l.username || '(no username)'}</div>
        {revealed[l.id] !== undefined && <code className="secret">{revealed[l.id]}</code>}
      </div>
      {l.matchesActive && (
        <button className="btn small primary" title="Fill this login into the page" onClick={() => void act(() => call('passwords:fill', l.id).then((r: any) => { if (!r?.password) throw new Error('No password field found on this page'); }))}>
          Fill
        </button>
      )}
      <button className="icon-btn small" title="Copy username" onClick={() => void act(() => call('passwords:copy', { id: l.id, field: 'username' }), 'Username copied')}>
        <Icon name="user" size={13} />
      </button>
      <button className="icon-btn small" title="Copy password (clipboard clears after 30 s)" onClick={() => void act(() => call('passwords:copy', { id: l.id, field: 'password' }), 'Password copied. The clipboard clears in 30 seconds.')}>
        <Icon name="key" size={13} />
      </button>
      <button
        className="icon-btn small"
        title={revealed[l.id] !== undefined ? 'Hide' : 'Show password'}
        onClick={() =>
          void act(async () => {
            if (revealed[l.id] !== undefined) return setRevealed(({ [l.id]: _, ...rest }) => rest);
            const pw = await call<string>('passwords:reveal', l.id);
            setRevealed((r) => ({ ...r, [l.id]: pw }));
          })
        }
      >
        <Icon name="eye" size={13} />
      </button>
      <button
        className="icon-btn small"
        title="Delete"
        onClick={() => {
          if (confirm(`Delete the saved login for ${l.username || l.domain}?`)) void act(() => call('passwords:delete', l.id).then(load));
        }}
      >
        <Icon name="trash" size={13} />
      </button>
    </div>
  );

  const here = items.filter((l) => l.matchesActive);
  const rest = items.filter((l) => !l.matchesActive);

  return (
    <div className="list passwords">
      <div className="action-bar">
        <button className="btn primary wide" onClick={() => setWizard((x) => !x)}>
          <Icon name="download" size={14} /> Import from Google
        </button>
        <div className="seg">
          <button className="btn small" onClick={() => setAdding((x) => !x)}>
            <Icon name="plus" size={13} /> Add
          </button>
          <button className="btn small" title="Import any Chrome, Edge, Firefox or Bitwarden CSV" onClick={() => void runImport()}>
            Import CSV
          </button>
          <button className="btn small" disabled={!total} onClick={() => void act(() => call('passwords:export'))}>
            Export
          </button>
        </div>
      </div>

      {wizard && (
        <div className="wizard">
          <p className="small">
            Google does not let any app read your saved passwords directly. You can bring them over in three steps; nothing leaves this computer.
          </p>
          <ol className="small">
            <li>
              <button className="link" onClick={() => void act(() => call('passwords:google'))}>
                Open Google Password Manager
              </button>{' '}
              in this profile and sign in to your Google account.
            </li>
            <li>Choose <b>Export passwords</b> and confirm with your Google password. Chrome-format CSV downloads to your Downloads folder.</li>
            <li>
              AETHER offers to import it as soon as the download finishes, or{' '}
              <button className="link" onClick={() => void runImport()}>
                choose the file
              </button>
              . Afterwards you can delete the CSV in one click.
            </li>
          </ol>
          <p className="muted small">Passwords are stored encrypted with your operating-system account (DPAPI on Windows). AETHER does not sync them back to Google.</p>
        </div>
      )}

      {lastImport && (
        <p className="small ok-text">
          {lastImport.file}: {lastImport.added} added, {lastImport.updated} updated, {lastImport.unchanged} already saved
          {lastImport.skipped.length ? `, ${lastImport.skipped.length} skipped (${lastImport.skipped.slice(0, 3).map((s) => `row ${s.line}: ${s.reason}`).join('; ')})` : ''}.
        </p>
      )}

      {adding && (
        <form
          className="wizard"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(
              () => call('passwords:add', { url: String(f.get('url')), username: String(f.get('username')), password: String(f.get('password')) }).then(() => { setAdding(false); load(); }),
              'Login saved',
            );
          }}
        >
          <input name="url" placeholder="Website" defaultValue={active && /^https?:/.test(active.url) ? new URL(active.url).origin : ''} required />
          <input name="username" placeholder="Username or email" autoComplete="off" />
          <input name="password" type="password" placeholder="Password" autoComplete="new-password" required />
          <button className="btn small primary" type="submit">
            Save
          </button>
        </form>
      )}

      <input className="search" placeholder={`Search ${total} saved logins`} value={q} onChange={(e) => setQ(e.target.value)} />
      {here.length > 0 && <h4 className="section-label">This site</h4>}
      {here.map(row)}
      {rest.length > 0 && here.length > 0 && <h4 className="section-label">All logins</h4>}
      {rest.map(row)}
      {!total && !wizard && (
        <div className="empty-state">
          <Icon name="key" size={28} />
          <strong>No saved logins yet</strong>
          <span>Import them from Google or another browser, or add one. They're encrypted with your Windows account.</span>
        </div>
      )}
    </div>
  );
}
