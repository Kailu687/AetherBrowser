import { useEffect, useRef, useState } from 'react';
import type { WindowState } from '../../shared/types';
import { call } from '../api';

/**
 * Quick thoughts, saved per workspace (or to a profile-wide inbox). Lets you
 * jot an idea for another project without leaving the one you are in.
 */
export function NotesPanel({ state }: { state: WindowState }) {
  const [target, setTarget] = useState<string | null>(state.workspace?.id ?? null);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const loadedFor = useRef<string | null | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setTarget(state.workspace?.id ?? null), [state.workspace?.id]);

  useEffect(() => {
    if (state.isPrivate) return;
    loadedFor.current = undefined;
    void call<string>('workspace:get-notes', target).then((n) => {
      setText(n);
      loadedFor.current = target;
      setStatus('idle');
    });
  }, [target, state.isPrivate]);

  const save = (value: string) => {
    if (loadedFor.current !== target) return;
    setStatus('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      call('workspace:set-notes', { id: target, notes: value })
        .then(() => setStatus('saved'))
        .catch(() => setStatus('error'));
    }, 400);
  };

  if (state.isPrivate) return <p className="muted">Notes are not saved in private windows.</p>;

  return (
    <div className="notes">
      <label className="small muted">
        Save to
        <select value={target ?? ''} onChange={(e) => setTarget(e.target.value || null)}>
          <option value="">Inbox ({state.profile.name})</option>
          {state.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
              {w.id === state.workspace?.id ? ' (this window)' : ''}
            </option>
          ))}
        </select>
      </label>
      <textarea
        value={text}
        placeholder={'Capture a thought, a link, a to-do…\nSaved automatically, locally.'}
        onChange={(e) => {
          setText(e.target.value);
          save(e.target.value);
        }}
      />
      <div className="small muted">{status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved on this device' : status === 'error' ? 'Could not save' : `${text.length.toLocaleString()} characters`}</div>
    </div>
  );
}
