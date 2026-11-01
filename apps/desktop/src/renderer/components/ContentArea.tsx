import { useEffect, useRef } from 'react';
import type { TabState, WindowState } from '../../shared/types';
import type { Snapshot } from '../App';
import { send } from '../api';
import { Icon } from './Icon';

/**
 * The area the web views are laid over. The UI only reports its rectangle;
 * the main process positions the views. Anything drawn here is visible only
 * where no view is shown: crash/error states, the split divider and the
 * snapshots painted while a popover is open.
 */
export function ContentArea({ state, snapshots, overlay }: { state: WindowState; snapshots: Snapshot[]; overlay: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        send('ui:layout', { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.max(0, r.width), height: Math.max(0, r.height) });
      });
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener('resize', report);
    report();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', report);
      cancelAnimationFrame(frame);
    };
  }, []);

  const split = state.split;
  const panes: { tab: TabState | undefined; style: React.CSSProperties }[] = split
    ? [
        { tab: state.tabs.find((t) => t.id === split.leftTabId), style: { left: 0, width: `calc(${split.ratio * 100}% - 3px)` } },
        { tab: state.tabs.find((t) => t.id === split.rightTabId), style: { left: `calc(${split.ratio * 100}% + 3px)`, right: 0 } },
      ]
    : [{ tab: state.tabs.find((t) => t.id === state.activeTabId), style: { left: 0, right: 0 } }];

  return (
    <div className="content" ref={ref}>
      {panes.map(({ tab, style }, i) =>
        tab ? (
          <div key={i} className={`pane ${split && tab.id === state.activeTabId ? 'focused' : ''}`} style={style}>
            <PaneFallback tab={tab} />
          </div>
        ) : null,
      )}
      {split && <SplitDivider ratio={split.ratio} />}
      {overlay &&
        snapshots.map((s, i) => (
          <img
            key={i}
            className="snapshot"
            src={s.dataUrl}
            alt=""
            style={{ left: s.rect.x, top: s.rect.y, width: s.rect.width, height: s.rect.height }}
          />
        ))}
      {overlay && <div className="overlay-dim" />}
    </div>
  );
}

function PaneFallback({ tab }: { tab: TabState }) {
  if (tab.crashed) {
    return (
      <div className="fallback">
        <div className="fallback-icon">
          <Icon name="bolt" size={28} />
        </div>
        <h2>This tab stopped working</h2>
        <p className="muted">The page crashed or ran out of memory. Other tabs are fine. Your place in the page is remembered.</p>
        <button className="btn primary" onClick={() => send('tab:reload', tab.id)}>
          Reload tab
        </button>
      </div>
    );
  }
  if (tab.error) {
    const offline = tab.error.code === -106;
    return (
      <div className="fallback">
        <div className="fallback-icon">
          <Icon name="info" size={28} />
        </div>
        <h2>{offline ? 'You are offline' : 'This page could not be loaded'}</h2>
        <p className="muted">{friendlyError(tab.error.code, tab.error.description)}</p>
        <p className="mono muted small">{tab.error.url}</p>
        <div className="row">
          <button className="btn primary" onClick={() => send('tab:reload', tab.id)}>
            Try again
          </button>
          {tab.canGoBack && (
            <button className="btn" onClick={() => send('tab:back', tab.id)}>
              Go back
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <>
      {tab.unresponsive && (
        <div className="hang-banner">
          This page is not responding.
          <button className="btn small" onClick={() => send('tab:reload', tab.id)}>
            Reload
          </button>
        </div>
      )}
      {tab.loading && <div className="load-bar" />}
    </>
  );
}

function friendlyError(code: number, description: string): string {
  const map: Record<number, string> = {
    [-105]: 'The site’s address could not be found. Check the spelling or your DNS settings.',
    [-106]: 'Check your network connection. AETHER will keep your tabs until you are back online.',
    [-102]: 'The site refused the connection. It may be down or blocking this network.',
    [-118]: 'The site took too long to respond.',
    [-200]: 'The site’s security certificate is not valid, so AETHER did not connect.',
    [-201]: 'The site’s certificate has expired or your system clock is wrong.',
    [-202]: 'The site’s certificate is not trusted.',
    [-501]: 'The connection is not secure.',
    [-20]: 'This request was blocked.',
    [-21]: 'The network changed while loading.',
  };
  return map[code] ?? `${description || 'Unknown error'} (${code})`;
}

function SplitDivider({ ratio }: { ratio: number }) {
  return (
    <div
      className="split-divider"
      style={{ left: `calc(${ratio * 100}% - 3px)` }}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        const parent = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => send('split:ratio', Math.max(0, Math.min(1, (ev.clientX - parent.left) / parent.width)));
        const up = () => {
          target.removeEventListener('pointermove', move);
          target.removeEventListener('pointerup', up);
        };
        target.addEventListener('pointermove', move);
        target.addEventListener('pointerup', up);
      }}
      onDoubleClick={() => send('split:ratio', 0.5)}
    />
  );
}
