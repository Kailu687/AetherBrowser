import { useState } from 'react';
import type { WindowState } from '../../shared/types';
import { call, send } from '../api';
import { Icon } from './Icon';
import { Popover } from './Popover';
import { toast } from './Toasts';

const COLORS = ['#7c8cff', '#38bdf8', '#34d399', '#fbbf24', '#f472b6', '#f87171', '#a78bfa', '#2dd4bf'];

export function ProfileMenu({ state, onClose }: { state: WindowState; onClose: () => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[state.profiles.length % COLORS.length]);
  const [editing, setEditing] = useState(false);
  const current = state.profile;

  return (
    <Popover className="profile-menu" onClose={onClose}>
      <div className="pm-current" style={{ borderColor: state.isPrivate ? '#a78bfa' : current.color }}>
        <span className="avatar big">{current.name.slice(0, 1).toUpperCase()}</span>
        <div>
          <div className="strong">{state.isPrivate ? `Private window (${current.name})` : current.name}</div>
          <div className="muted small">
            {state.isPrivate ? 'Nothing is kept after this window closes.' : `${current.openWindows} open window${current.openWindows === 1 ? '' : 's'} · own cookies, sign-ins and history`}
          </div>
        </div>
      </div>

      {!state.isPrivate && editing && (
        <ProfileSettings state={state} onDone={() => setEditing(false)} />
      )}

      {!editing && (
        <>
          <div className="pm-section">Profiles</div>
          {state.profiles.map((p) => (
            <button
              key={p.id}
              className={`menu-item ${p.id === current.id && !state.isPrivate ? 'current' : ''}`}
              onClick={() => {
                send('profile:open', p.id);
                onClose();
              }}
              title={p.savedWindows ? `Reopens ${p.savedWindows} kept window(s)` : 'Opens a new window in this profile'}
            >
              <span className="dot" style={{ background: p.color }} />
              <span className="grow">{p.name}</span>
              <span className="muted small">{p.openWindows ? `${p.openWindows} open` : p.savedWindows ? `${p.savedWindows} kept` : ''}</span>
            </button>
          ))}

          {creating ? (
            <form
              className="pm-create"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                void call('profile:create', { name: name.trim(), color }).then(() => {
                  toast(`Profile “${name.trim()}” created`);
                  onClose();
                });
              }}
            >
              <input autoFocus placeholder="Profile name, e.g. VIT Chennai" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
              <div className="swatches">
                {COLORS.map((c) => (
                  <button type="button" key={c} className={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
                ))}
              </div>
              <div className="row">
                <button type="button" className="btn" onClick={() => setCreating(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn primary">
                  Create and open
                </button>
              </div>
            </form>
          ) : (
            <button className="menu-item" onClick={() => setCreating(true)}>
              <Icon name="plus" /> <span className="grow">Add profile</span>
            </button>
          )}

          <div className="pm-divider" />
          <button
            className="menu-item"
            onClick={() => {
              send('window:new');
              onClose();
            }}
          >
            <Icon name="window" /> <span className="grow">New window</span> <kbd>Ctrl+N</kbd>
          </button>
          <button
            className="menu-item"
            onClick={() => {
              send('window:new-private');
              onClose();
            }}
          >
            <Icon name="mask" /> <span className="grow">New private window</span> <kbd>Ctrl+Shift+N</kbd>
          </button>
          {!state.isPrivate && (
            <button className="menu-item" onClick={() => setEditing(true)}>
              <Icon name="settings" /> <span className="grow">Profile settings</span>
            </button>
          )}
        </>
      )}
    </Popover>
  );
}

function ProfileSettings({ state, onDone }: { state: WindowState; onDone: () => void }) {
  const p = state.profile;
  const [name, setName] = useState(p.name);
  const update = (patch: Record<string, unknown>) => send('profile:update', { id: p.id, ...patch });
  return (
    <div className="pm-settings">
      <label>
        Name
        <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== p.name && update({ name: name.trim() })} />
      </label>
      <div className="swatches">
        {COLORS.map((c) => (
          <button key={c} className={`swatch ${c === p.color ? 'on' : ''}`} style={{ background: c }} onClick={() => update({ color: c })} aria-label={c} />
        ))}
      </div>
      <label>
        Search engine
        <select value={p.searchEngine} onChange={(e) => update({ searchEngine: e.target.value })}>
          <option value="google">Google</option>
          <option value="duckduckgo">DuckDuckGo</option>
          <option value="brave">Brave Search</option>
          <option value="bing">Bing</option>
          <option value="startpage">Startpage</option>
          <option value="ecosia">Ecosia</option>
        </select>
      </label>
      <label>
        When I close a window
        <select value={p.closeBehavior} onChange={(e) => update({ closeBehavior: e.target.value })}>
          <option value="ask">Ask whether to keep it</option>
          <option value="save">Always keep its tabs</option>
          <option value="discard">Never keep it</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={p.restoreOnStartup} onChange={(e) => update({ restoreOnStartup: e.target.checked })} /> Reopen this profile’s windows when AETHER starts
      </label>
      <div className="row">
        <button className="btn" onClick={() => void call('profile:export', p.id).then((ok) => ok && toast('Profile exported'))}>
          Export data
        </button>
        <button className="btn danger" onClick={() => send('profile:delete', p.id)}>
          Delete profile…
        </button>
        <span className="grow" />
        <button className="btn primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
