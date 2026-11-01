import { useEffect, useState } from 'react';
import type { WindowState } from '../../shared/types';
import { call, send } from '../api';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';

interface Bookmark {
  id: number;
  parentId: number | null;
  title: string;
  url: string | null;
}

export function BookmarksPanel({ state }: { state: WindowState }) {
  const [items, setItems] = useState<Bookmark[]>([]);
  const [q, setQ] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [open, setOpen] = useState<Set<number>>(new Set());

  const load = () => void call<Bookmark[]>('bookmarks:list').then(setItems);
  useEffect(load, [state.bookmarked, state.profile.id]);

  const filtered = q ? items.filter((b) => b.url && `${b.title} ${b.url}`.toLowerCase().includes(q.toLowerCase())) : null;
  const children = (parent: number | null) => items.filter((b) => b.parentId === parent);
  const active = state.tabs.find((t) => t.id === state.activeTabId);

  const row = (b: Bookmark, depth: number) =>
    b.url ? (
      <div key={b.id} className="list-row" style={{ paddingLeft: 8 + depth * 14 }}>
        <button className="link grow ellipsis" title={b.url} onClick={() => send('tab:navigate', { input: b.url })} onAuxClick={() => send('tab:new', { url: b.url, background: true })}>
          {b.title}
        </button>
        <button className="icon-btn small" title="Delete" onClick={() => void call('bookmarks:delete', b.id).then(load)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
    ) : (
      <div key={b.id}>
        <div className="list-row folder" style={{ paddingLeft: 8 + depth * 14 }}>
          <button className="link grow" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(b.id)) n.delete(b.id); else n.add(b.id); return n; })}>
            <Icon name="folder" size={14} /> {b.title}
          </button>
          {active && (
            <button className="icon-btn small" title="Add current page to this folder" onClick={() => void call('bookmarks:add', { title: active.title, url: active.url, parentId: b.id }).then(load)}>
              <Icon name="plus" size={13} />
            </button>
          )}
          <button className="icon-btn small" title="Delete folder and contents" onClick={() => void call('bookmarks:delete', b.id).then(load)}>
            <Icon name="trash" size={13} />
          </button>
        </div>
        {open.has(b.id) && children(b.id).map((c) => row(c, depth + 1))}
      </div>
    );

  return (
    <div className="list">
      <input className="search" placeholder="Search bookmarks" value={q} onChange={(e) => setQ(e.target.value)} />
      {filtered ? filtered.map((b) => row(b, 0)) : children(null).map((b) => row(b, 0))}
      {!items.length && <EmptyState icon="bookmark" title="No bookmarks yet" hint="Press Ctrl+D or the star in the address bar to save a page." />}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (newFolder.trim()) void call('bookmarks:add', { title: newFolder.trim(), url: null }).then(() => { setNewFolder(''); load(); });
        }}
      >
        <input placeholder="New folder (e.g. Datasheets)" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} />
        <button className="btn" type="submit">Add</button>
      </form>
    </div>
  );
}
