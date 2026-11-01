import { useEffect, useMemo, useRef, useState } from 'react';
import type { WindowState } from '../../shared/types';
import { send } from '../api';
import { THEMES } from '../../shared/themes';
import type { PanelId } from './Sidebar';
import { Popover } from './Popover';

interface Item {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

/** Ctrl+K: one place to reach tabs, workspaces, profiles, panels and actions. */
export function CommandPalette({ state, bangs, onClose, openPanel }: { state: WindowState; bangs: { trigger: string; name: string }[]; onClose: () => void; openPanel: (p: PanelId) => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const t of state.tabs) out.push({ id: `tab-${t.id}`, group: 'Tabs', label: t.title || t.url, hint: t.url, run: () => send('tab:activate', t.id) });
    if (!state.isPrivate) {
      for (const w of state.workspaces) out.push({ id: `ws-${w.id}`, group: 'Workspaces', label: `Switch to ${w.name}`, hint: `${w.tabCount} tab${w.tabCount === 1 ? "" : "s"}`, run: () => send('workspace:switch', w.id) });
      for (const p of state.profiles) out.push({ id: `p-${p.id}`, group: 'Profiles', label: `Open profile ${p.name}`, run: () => send('profile:open', p.id) });
    }
    const actions: [string, string, () => void][] = [
      ['New tab', 'Ctrl+T', () => send('tab:new')],
      ['New window', 'Ctrl+N', () => send('window:new')],
      ['New private window', 'Ctrl+Shift+N', () => send('window:new-private')],
      ['Reopen closed tab', 'Ctrl+Shift+T', () => send('tab:reopen-closed')],
      ['Toggle split view', 'Ctrl+\\', () => send('split:toggle')],
      ['Bookmark this page', 'Ctrl+D', () => send('bookmarks:toggle')],
      ['Notes and thoughts', 'Ctrl+Shift+K', () => openPanel('notes')],
      ['History', 'Ctrl+H', () => openPanel('history')],
      ['Bookmarks', 'Ctrl+Shift+O', () => openPanel('bookmarks')],
      ['Downloads', 'Ctrl+J', () => openPanel('downloads')],
      ['Reader view', 'Ctrl+Alt+R', () => state.activeTabId && send('tab:reader', state.activeTabId)],
      ['Toggle bookmarks bar', 'Ctrl+Shift+B', () => send('bookmarks:bar-toggle')],
      ['Passwords', 'Ctrl+Shift+L', () => openPanel('passwords')],
      ['Import passwords from Google', '', () => openPanel('passwords')],
      ['Settings', '', () => openPanel('settings')],
      ['Print page', 'Ctrl+P', () => state.activeTabId && send('tab:print', state.activeTabId)],
      ['Developer tools', 'F12', () => state.activeTabId && send('tab:devtools', state.activeTabId)],
      ['About AETHER', '', () => send('tab:new', { url: 'aether://about' })],
    ];
    for (const [label, hint, run] of actions) out.push({ id: `a-${label}`, group: 'Actions', label, hint, run });
    for (const t of [{ id: 'system', name: 'Match system' }, ...Object.values(THEMES)])
      out.push({ id: `t-${t.id}`, group: 'Themes', label: `Theme: ${t.name}`, hint: state.themeId === t.id ? 'current' : '', run: () => send('theme:set', t.id) });
    for (const b of bangs) out.push({ id: `b-${b.trigger}`, group: 'Search shortcuts', label: `!${b.trigger}  ${b.name}`, hint: 'type in address bar', run: () => send('tab:new', { url: `aether://search?q=${encodeURIComponent('!' + b.trigger)}` }) });
    return out;
  }, [state, bangs, openPanel]);

  const filtered = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = words.length ? items.filter((i) => words.every((w) => `${i.label} ${i.hint ?? ''} ${i.group}`.toLowerCase().includes(w))) : items.filter((i) => i.group !== 'Search shortcuts');
    return list.slice(0, 50);
  }, [items, q]);

  const run = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };

  let lastGroup = '';
  return (
    <Popover className="palette" onClose={onClose}>
      <input
        ref={inputRef}
        className="palette-input"
        placeholder="Jump to a tab, workspace, profile or action…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setSel(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSel((s) => Math.min(s + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSel((s) => Math.max(s - 1, 0));
          } else if (e.key === 'Enter') run(filtered[sel]);
          else if (e.key === 'Escape') onClose();
        }}
      />
      <div className="palette-list">
        {filtered.length === 0 && <div className="muted small pad">No matches</div>}
        {filtered.map((i, idx) => {
          const header = i.group !== lastGroup ? i.group : null;
          lastGroup = i.group;
          return (
            <div key={i.id}>
              {header && <div className="pm-section">{header}</div>}
              <button className={`menu-item ${idx === sel ? 'selected' : ''}`} onMouseEnter={() => setSel(idx)} onClick={() => run(i)}>
                <span className="grow ellipsis">{i.label}</span>
                {i.hint && <span className="muted small ellipsis hint">{i.hint}</span>}
              </button>
            </div>
          );
        })}
      </div>
    </Popover>
  );
}
