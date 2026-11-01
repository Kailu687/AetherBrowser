import { useEffect, useState } from 'react';
import type { SavedWindowSummary, WindowState } from '../../shared/types';
import { call, send } from '../api';
import { Icon } from './Icon';
import { Popover } from './Popover';
import { toast } from './Toasts';

const COLORS = ['#7c8cff', '#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#f87171', '#a78bfa', '#2dd4bf'];

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function WorkspaceMenu({ state, onClose }: { state: WindowState; onClose: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[state.workspaces.length % COLORS.length]);
  const [saved, setSaved] = useState<SavedWindowSummary[]>([]);

  useEffect(() => {
    if (!state.isPrivate) void call<SavedWindowSummary[]>('window:saved-list').then(setSaved);
  }, [state.isPrivate, state.profile.savedWindows]);

  if (state.isPrivate) {
    return (
      <Popover className="ws-menu" onClose={onClose}>
        <p className="muted">Workspaces are not saved in private windows. Open a normal window to use them.</p>
      </Popover>
    );
  }

  const create = (empty: boolean) => {
    const n = name.trim();
    if (!n) return toast('Give the workspace a name first', 'error');
    void call('workspace:create-from-window', { name: n, color, empty }).then(() => {
      toast(empty ? `Switched to new workspace “${n}”` : `This window is now “${n}”`);
      onClose();
    });
  };

  return (
    <Popover className="ws-menu" onClose={onClose}>
      <div className="pm-section">Workspaces in {state.profile.name}</div>
      <p className="muted small">A workspace keeps a research context: its tabs, reading positions and notes. Switching saves where you are and restores where you were.</p>
      {state.workspaces.length === 0 && <p className="muted small">No workspaces yet.</p>}
      {state.workspaces.map((ws) => {
        const here = state.workspace?.id === ws.id;
        return (
          <div key={ws.id} className={`ws-row ${here ? 'current' : ''}`}>
            <button
              className="menu-item grow"
              onClick={() => {
                send('workspace:switch', ws.id);
                onClose();
              }}
              title={here ? 'Current workspace' : ws.openIn ? 'Open in another window: focus it' : 'Switch this window to it'}
            >
              <span className="dot" style={{ background: ws.color }} />
              <span className="grow">{ws.name}</span>
              <span className="muted small">
                {here ? 'here' : ws.openIn ? 'open' : `${ws.tabCount} tab${ws.tabCount === 1 ? "" : "s"} · ${ago(ws.updatedAt)}`}
              </span>
            </button>
            {!here && !ws.openIn && (
              <button className="icon-btn small" title="Open in a new window" onClick={() => { send('workspace:open-in-new-window', ws.id); onClose(); }}>
                <Icon name="external" size={14} />
              </button>
            )}
            <button className="icon-btn small" title="Delete workspace" onClick={() => send('workspace:delete', ws.id)}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        );
      })}
      {state.workspace && (
        <button className="menu-item" onClick={() => { send('workspace:detach'); onClose(); }}>
          <Icon name="close" /> <span className="grow">Unlink this window from “{state.workspace.name}”</span>
        </button>
      )}

      <div className="pm-divider" />
      <div className="ws-create">
        <input placeholder="New workspace, e.g. VLSI Internship" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create(!!state.workspace)} />
        <div className="swatches">
          {COLORS.map((c) => (
            <button key={c} className={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
          ))}
        </div>
        <div className="row">
          {!state.workspace && (
            <button className="btn" onClick={() => create(false)} title="Turn this window's tabs into the workspace">
              Save these tabs as workspace
            </button>
          )}
          <button className="btn primary" onClick={() => create(true)} title="Start fresh; current tabs are kept safely">
            Start empty workspace
          </button>
        </div>
      </div>

      {saved.length > 0 && (
        <>
          <div className="pm-divider" />
          <div className="pm-section">Kept windows</div>
          {saved.map((s) => (
            <div key={s.id} className="ws-row">
              <button className="menu-item grow" onClick={() => { send('window:open-saved', s.id); onClose(); }}>
                <Icon name="window" />
                <span className="grow ellipsis">{s.workspaceName ?? s.title}</span>
                <span className="muted small">{s.tabCount} tab{s.tabCount === 1 ? "" : "s"} · {ago(s.updatedAt)}</span>
              </button>
              <button className="icon-btn small" title="Forget this window" onClick={() => { send('window:delete-saved', s.id); setSaved(saved.filter((x) => x.id !== s.id)); }}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </>
      )}
    </Popover>
  );
}
