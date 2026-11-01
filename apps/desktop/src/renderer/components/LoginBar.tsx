import type { WindowState } from '../../shared/types';
import { send } from '../api';
import { Icon } from './Icon';

/** "Save password?" strip after signing in. The password never reaches the UI. */
export function LoginBar({ prompt }: { prompt: NonNullable<WindowState['loginPrompt']> }) {
  return (
    <div className="permission-bar login-bar" role="alertdialog">
      <Icon name="key" />
      <span>
        {prompt.update ? 'Update the saved password' : 'Save your password'} for <strong>{prompt.site}</strong>
        {prompt.username ? ` (${prompt.username})` : ''}? It is encrypted with your Windows account.
      </span>
      <button className="btn" onClick={() => send('passwords:prompt-respond', 'never')}>
        Never for this site
      </button>
      <button className="btn" onClick={() => send('passwords:prompt-respond', 'dismiss')}>
        Not now
      </button>
      <button className="btn primary" onClick={() => send('passwords:prompt-respond', 'save')}>
        {prompt.update ? 'Update' : 'Save'}
      </button>
    </div>
  );
}
