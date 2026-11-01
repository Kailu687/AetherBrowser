import { useEffect, useState } from 'react';
import type { DownloadItemState } from '../../shared/types';
import { bridge, call, send } from '../api';
import { EmptyState } from '../components/EmptyState';

function size(n: number): string {
  if (n <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function DownloadsPanel() {
  const [items, setItems] = useState<DownloadItemState[]>([]);
  useEffect(() => {
    void call<DownloadItemState[]>('downloads:list').then(setItems);
    return bridge.on('downloads', (list: DownloadItemState[]) => setItems(list));
  }, []);
  const act = (id: number, action: string) => send('downloads:action', { id, action });

  return (
    <div className="list">
      {!items.length && <EmptyState icon="download" title="No downloads yet" hint="Files you download in this profile show up here." />}
      {items.map((d) => {
        const pct = d.totalBytes > 0 ? Math.round((d.receivedBytes / d.totalBytes) * 100) : null;
        return (
          <div key={d.id} className={`download ${d.state}`}>
            <div className="ellipsis strong" title={d.path || d.filename}>
              {d.filename}
            </div>
            <div className="small muted">
              {d.state === 'progressing' ? `${d.paused ? 'Paused · ' : ''}${size(d.receivedBytes)}${d.totalBytes ? ` of ${size(d.totalBytes)}` : ''}` : d.state === 'completed' ? size(d.totalBytes || d.receivedBytes) : d.state === 'cancelled' ? 'Cancelled' : 'Failed or interrupted'}
            </div>
            {d.state === 'progressing' && <progress max={100} value={pct ?? undefined} />}
            <div className="row">
              {d.state === 'completed' && <button className="btn small" onClick={() => act(d.id, 'open')}>Open</button>}
              {d.state === 'completed' && <button className="btn small" onClick={() => act(d.id, 'show')}>Show in folder</button>}
              {d.state === 'progressing' && <button className="btn small" onClick={() => act(d.id, d.paused ? 'resume' : 'pause')}>{d.paused ? 'Resume' : 'Pause'}</button>}
              {d.state === 'progressing' && <button className="btn small" onClick={() => act(d.id, 'cancel')}>Cancel</button>}
              {d.state === 'interrupted' && d.url && <button className="btn small" onClick={() => send('tab:new', { url: d.url, background: true })}>Retry</button>}
              <span className="grow" />
              {d.state !== 'progressing' && <button className="btn small ghost" onClick={() => act(d.id, 'remove')}>Remove</button>}
            </div>
          </div>
        );
      })}
      {items.some((d) => d.state !== 'progressing') && (
        <button className="btn small" onClick={() => void call<DownloadItemState[]>('downloads:clear').then(setItems)}>
          Clear finished
        </button>
      )}
    </div>
  );
}
