import { useEffect, useState } from 'react';
import { bridge, call, send } from '../api';

interface GoogleStatus {
  configured: boolean;
  clientId: string | null;
  hasSecret: boolean;
  encryption: boolean;
  account: { email: string; name?: string; picture?: string; connectedAt: number; lastPush?: number; lastPull?: number } | null;
  pending: boolean;
  isPrivate: boolean;
}

const g = <T,>(method: string, payload?: unknown) => call<T>('module:invoke', { moduleId: 'aether.google', method, payload });
const when = (t?: number) => (t ? new Date(t).toLocaleString() : 'never');

/**
 * Settings → Google account. Sign-in happens in your normal browser on Google's
 * own page; AETHER never sees your password and keeps only an encrypted token.
 */
export function GoogleSection({ profileId }: { profileId: string }) {
  const [s, setS] = useState<GoogleStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const load = () => void g<GoogleStatus>('status').then(setS).catch(() => setS(null));
  useEffect(() => {
    load();
    return bridge.on('module-event', (e: { event: string }) => {
      if (e.event === 'aether.google:changed') load();
    });
  }, [profileId]);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setErr(null);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
    } catch (e) {
      setErr(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
    load();
  };
  if (!s) return null;
  if (s.isPrivate) return <p className="small muted">Google sign-in is off in private windows.</p>;

  return (
    <div className="google-section">
      {s.account ? (
        <>
          <div className="list-row">
            {s.account.picture ? <img src={s.account.picture} alt="" width={28} height={28} style={{ borderRadius: '50%' }} referrerPolicy="no-referrer" /> : <span className="avatar">G</span>}
            <span className="grow">
              <b>{s.account.name ?? s.account.email}</b>
              <br />
              <small className="muted">{s.account.email}</small>
            </span>
          </div>
          <p className="small muted">
            Sync keeps your bookmarks, theme and search engine in a hidden AETHER folder in your Google Drive that only AETHER can see. Passwords, history and cookies are never uploaded. Last upload: {when(s.account.lastPush)} · last download: {when(s.account.lastPull)}.
          </p>
          <div className="row gap wrap">
            <button className="btn small" onClick={() => void act(() => g('sync.push'), 'Uploaded to your Drive.')}>
              Upload now
            </button>
            <button className="btn small" onClick={() => void act(async () => { const r = await g<{ added: number; empty?: boolean }>('sync.pull'); setNote(r.empty ? 'Nothing in your Drive yet.' : `Merged ${r.added} new bookmark${r.added === 1 ? '' : 's'}.`); })}>
              Download and merge
            </button>
            <button className="btn small" onClick={() => confirm('Disconnect Google? AETHER revokes its access; your synced copy stays in Drive.') && void act(() => g('disconnect', {}), 'Disconnected.')}>
              Disconnect
            </button>
            <button className="btn small danger" onClick={() => confirm('Disconnect and delete the AETHER copy from your Drive?') && void act(() => g('disconnect', { deleteCloudCopy: true }), 'Disconnected and removed from Drive.')}>
              Disconnect and delete cloud copy
            </button>
          </div>
        </>
      ) : s.pending ? (
        <div className="row gap">
          <span className="grow small">Finish signing in in your browser. This window updates when you're done.</span>
          <button className="btn small" onClick={() => void act(() => g('cancel'))}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <p className="small muted">Connect Google to sync bookmarks and settings through your own Google Drive. Optional; AETHER works fully without it.</p>
          {!s.encryption && <p className="small danger">This system has no OS encryption available, so AETHER won't store Google sign-in.</p>}
          <div className="row gap wrap">
            <button className="btn small primary" disabled={!s.configured || !s.encryption} onClick={() => void act(() => g('signIn'), 'Connected.')}>
              Sign in with Google
            </button>
            <button className="btn small" onClick={() => setSetup((v) => !v)}>
              {s.configured ? 'Change OAuth client' : 'Set up (one time)'}
            </button>
          </div>
        </>
      )}
      {setup && (
        <div className="google-setup">
          <ol className="small">
            <li>
              Open <button className="link" onClick={() => send('tab:new', { url: 'https://console.cloud.google.com/apis/credentials' })}>Google Cloud Console → Credentials</button> and create a project.
            </li>
            <li>Enable the <b>Google Drive API</b>, then set up the OAuth consent screen (External, add yourself as a test user).</li>
            <li>
              Create credentials → OAuth client ID → <b>Desktop app</b>. Copy the client ID and client secret here.
            </li>
          </ol>
          <input className="wb-input" placeholder="1234-abc.apps.googleusercontent.com" value={clientId} onChange={(e) => setClientId(e.target.value)} />
          <input className="wb-input" placeholder={s.hasSecret ? 'Client secret saved (leave blank to keep)' : 'Client secret'} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
          <p className="small muted">The ID and secret stay on this PC, encrypted with your Windows account. For Desktop-app clients Google does not treat the secret as confidential; your sign-in is protected by PKCE.</p>
          <button
            className="btn small primary"
            onClick={() =>
              void act(async () => {
                await g('configure', { clientId, ...(secret ? { clientSecret: secret } : {}) });
                setSetup(false);
                setSecret('');
              }, 'Saved. Now click Sign in with Google.')
            }
          >
            Save
          </button>
        </div>
      )}
      {s.clientId && !setup && <p className="small muted mono">Client: {s.clientId.slice(0, 12)}…</p>}
      {note && <p className="small">{note}</p>}
      {err && <p className="small danger">{err}</p>}
    </div>
  );
}
