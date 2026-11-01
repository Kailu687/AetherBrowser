import { useEffect, useState } from 'react';
import type { WindowState } from '../../shared/types';
import { call, send } from '../api';
import { Icon } from './Icon';

interface Bookmark {
  id: number;
  parentId: number | null;
  title: string;
  url: string | null;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Top-level bookmarks under the toolbar. Folders open a native menu (it draws above web pages). */
export function BookmarksBar({ state }: { state: WindowState }) {
  const [items, setItems] = useState<Bookmark[]>([]);
  useEffect(() => {
    void call<Bookmark[]>('bookmarks:list').then((all) => setItems(all.filter((b) => b.parentId === null)));
  }, [state.bookmarksRev, state.profile.id]);

  const menu = (b: Bookmark, el: HTMLElement, context: boolean, e?: { clientX: number; clientY: number }) => {
    const r = el.getBoundingClientRect();
    const x = Math.round(context && e ? e.clientX : r.left);
    const y = Math.round(context && e ? e.clientY : r.bottom);
    send('bookmarks:item-menu', { id: b.id, x, y, context });
  };

  return (
    <div className="bookmarks-bar" role="toolbar" aria-label="Bookmarks bar">
      {items.map((b) => (
        <button
          key={b.id}
          className="bm-item"
          title={b.url ?? b.title}
          onClick={(e) => (b.url ? send('tab:navigate', { input: b.url }) : menu(b, e.currentTarget, false))}
          onAuxClick={(e) => {
            if (e.button === 1 && b.url) send('tab:new', { url: b.url, background: true });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            menu(b, e.currentTarget, true, e);
          }}
        >
          {b.url ? <span className="bm-dot">{hostOf(b.url).slice(0, 1).toUpperCase()}</span> : <Icon name="folder" size={13} />}
          <span className="bm-label">{b.title || hostOf(b.url ?? '')}</span>
          {!b.url && <Icon name="chevron" size={11} />}
        </button>
      ))}
      {!items.length && <span className="bm-empty">Press Ctrl+D to bookmark a page, Ctrl+Shift+B to hide this bar</span>}
    </div>
  );
}
