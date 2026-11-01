import { useState } from 'react';
import type { PermissionPrompt } from '../../shared/types';

const LABELS: Record<string, string> = {
  media: 'use your camera or microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  midi: 'use MIDI devices',
  midiSysex: 'get full control of MIDI devices',
  'clipboard-read': 'read your clipboard',
  'display-capture': 'capture your screen',
  'idle-detection': 'know when you are idle',
  'speaker-selection': 'choose audio output devices',
};

export function PermissionBar({ prompt, isPrivate, onRespond }: { prompt: PermissionPrompt; isPrivate: boolean; onRespond: (allow: boolean, remember: boolean) => void }) {
  const [remember, setRemember] = useState(!isPrivate);
  return (
    <div className="permission-bar" role="alertdialog">
      <span>
        <strong>{prompt.origin.replace(/^https?:\/\//, '')}</strong> wants to {LABELS[prompt.permission] ?? prompt.permission}.
      </span>
      {!isPrivate && (
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember for this profile
        </label>
      )}
      <button className="btn" onClick={() => onRespond(false, remember)}>
        Block
      </button>
      <button className="btn primary" onClick={() => onRespond(true, remember)}>
        Allow
      </button>
    </div>
  );
}
