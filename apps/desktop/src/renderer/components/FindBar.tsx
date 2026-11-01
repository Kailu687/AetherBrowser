import { useEffect, useRef, useState } from 'react';
import { bridge, send } from '../api';
import { Icon } from './Icon';

export function FindBar({ tabId, onClose }: { tabId: number; onClose: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ matches: number; active: number } | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    const off = bridge.on('find-result', (r: { tabId: number; matches: number; active: number }) => {
      if (r.tabId === tabId) setResult({ matches: r.matches, active: r.active });
    });
    return () => {
      off();
      send('tab:stop-find', tabId);
    };
  }, [tabId]);

  const find = (forward = true, findNext = false) => {
    if (text) send('tab:find', { tabId, text, forward, findNext });
  };

  return (
    <div className="findbar">
      <Icon name="search" size={14} />
      <input
        ref={ref}
        value={text}
        placeholder="Find in page"
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value) send('tab:find', { tabId, text: e.target.value });
          else {
            send('tab:stop-find', tabId);
            setResult(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') find(!e.shiftKey, true);
          if (e.key === 'Escape') onClose();
        }}
      />
      <span className="muted small">{result ? `${result.active}/${result.matches}` : ''}</span>
      <button className="icon-btn small" onClick={() => find(false, true)} title="Previous (Shift+Enter)">
        <Icon name="back" size={14} />
      </button>
      <button className="icon-btn small" onClick={() => find(true, true)} title="Next (Enter)">
        <Icon name="forward" size={14} />
      </button>
      <button className="icon-btn small" onClick={onClose} title="Close (Esc)">
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
