import { useEffect, useState } from 'react';
import type { WindowState } from '../../shared/types';
import { call, send } from '../api';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';

interface Entry {
  id: number;
  url: string;
  title: string;
  visitCount: number;
  lastVisitAt: number;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export function HistoryPanel({ state }: { state: WindowState }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<Entry[]>([]);
  const load = () => void call<Entry[]>('history:list', { query: q || undefined }).then(setItems);
  useEffect(() => {
    const id = setTimeout(load, 150);
    return () => clearTimeout(id);
  }, [q, state.profile.id]);

  if (state.isPrivate) return <EmptyState icon="mask" title="Private window" hint="Private windows don't record history." />;

  let last = '';
  return (
    <div className="list">
      <input className="search" placeholder="Search history" value={q} onChange={(e) => setQ(e.target.value)} />
      {items.map((e) => {
        const label = dayLabel(e.lastVisitAt);
        const header = label !== last ? label : null;
        last = label;
        return (
          <div key={e.id}>
            {header && <div className="pm-section">{header}</div>}
            <div className="list-row">
              <span className="muted small time">{new Date(e.lastVisitAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
              <button className="link grow ellipsis" title={e.url} onClick={() => send('tab:navigate', { input: e.url })} onAuxClick={() => send('tab:new', { url: e.url, background: true })}>
                {e.title || e.url}
              </button>
              <button className="icon-btn small" title="Remove from history" onClick={() => void call('history:delete', e.id).then(load)}>
                <Icon name="close" size={12} />
              </button>
            </div>
          </div>
        );
      })}
      {!items.length && <EmptyState icon={q ? 'search' : 'history'} title={q ? 'No matches' : 'No history yet'} hint={q ? undefined : 'Pages you visit in this profile show up here.'} />}
      <div className="pm-divider" />
      <div className="row wrap">
        <span className="small muted">Clear:</span>
        {(['hour', 'day', 'week', 'all'] as const).map((r) => (
          <button key={r} className="btn small" onClick={() => void call('history:clear', r).then(load)}>
            {r === 'all' ? 'Everything' : `Last ${r}`}
          </button>
        ))}
      </div>
    </div>
  );
}
