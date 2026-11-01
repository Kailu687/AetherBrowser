import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Google OAuth for installed apps: system browser + loopback redirect + PKCE
 * (RFC 8252). AETHER never shows Google's sign-in page inside its own window,
 * so it never sees the user's Google password.
 */
export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo';

/** Least privilege: identity plus Drive's hidden per-app folder (cannot see the user's other files). */
export const DEFAULT_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.appdata'];

export interface GoogleClient {
  clientId: string;
  clientSecret?: string;
}

export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
  scope?: string;
  idToken?: string;
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function isValidClientId(id: string): boolean {
  return /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id.trim());
}

export function authUrl(o: { clientId: string; redirectUri: string; challenge: string; state: string; scopes?: string[]; loginHint?: string }): string {
  const u = new URL(GOOGLE_AUTH);
  u.searchParams.set('client_id', o.clientId);
  u.searchParams.set('redirect_uri', o.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', (o.scopes ?? DEFAULT_SCOPES).join(' '));
  u.searchParams.set('code_challenge', o.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', o.state);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  if (o.loginHint) u.searchParams.set('login_hint', o.loginHint);
  return u.toString();
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function parseTokens(j: Record<string, unknown>, now: number): TokenSet {
  if (typeof j.access_token !== 'string') throw new Error(typeof j.error === 'string' ? `google: ${j.error}${j.error_description ? ` (${String(j.error_description)})` : ''}` : 'google: no access token');
  return {
    accessToken: j.access_token,
    expiresAt: now + (Number(j.expires_in) || 3600) * 1000 - 60_000,
    refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : undefined,
    scope: typeof j.scope === 'string' ? j.scope : undefined,
    idToken: typeof j.id_token === 'string' ? j.id_token : undefined,
  };
}

async function tokenRequest(fetch: Fetch, body: Record<string, string>, now = Date.now()): Promise<TokenSet> {
  const r = await fetch(GOOGLE_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return parseTokens(j, now);
}

export function exchangeCode(fetch: Fetch, c: GoogleClient, code: string, verifier: string, redirectUri: string): Promise<TokenSet> {
  return tokenRequest(fetch, { client_id: c.clientId, ...(c.clientSecret ? { client_secret: c.clientSecret } : {}), code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri });
}

export function refreshTokens(fetch: Fetch, c: GoogleClient, refreshToken: string): Promise<TokenSet> {
  return tokenRequest(fetch, { client_id: c.clientId, ...(c.clientSecret ? { client_secret: c.clientSecret } : {}), refresh_token: refreshToken, grant_type: 'refresh_token' });
}

export async function revoke(fetch: Fetch, token: string): Promise<boolean> {
  const r = await fetch(GOOGLE_REVOKE, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() }).catch(() => null);
  return !!r?.ok;
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;background:#0f1115;color:#e8eaf0"><div><h2>${title}</h2><p>${body}</p></div>`;

/**
 * Listens once on 127.0.0.1 (random port) for Google's redirect. Resolves with
 * the authorization code when `state` matches; rejects on error, mismatch or timeout.
 */
export function loopback(opts: { state: string; timeoutMs?: number }): Promise<{ redirectUri: string; code: Promise<string>; close(): void }> {
  return new Promise((resolveStart, rejectStart) => {
    let server: Server;
    let done = false;
    let timer: NodeJS.Timeout;
    let resolveCode!: (c: string) => void;
    let rejectCode!: (e: Error) => void;
    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });
    code.catch(() => undefined);
    const finish = () => {
      done = true;
      clearTimeout(timer);
      server.close();
    };
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/' || done) {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const c = url.searchParams.get('code');
      const st = url.searchParams.get('state');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      if (err || !c || st !== opts.state) {
        res.writeHead(400).end(PAGE('Sign-in not completed', 'You can close this tab and try again from AETHER.'));
        finish();
        rejectCode(new Error(err ? `google: ${err}` : st !== opts.state ? 'google: state mismatch' : 'google: no code'));
        return;
      }
      res.writeHead(200).end(PAGE('Signed in to AETHER', 'You can close this tab and return to AETHER.'));
      finish();
      resolveCode(c);
    });
    server.on('error', rejectStart);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      timer = setTimeout(() => {
        if (done) return;
        finish();
        rejectCode(new Error('google: sign-in timed out'));
      }, opts.timeoutMs ?? 5 * 60_000);
      resolveStart({
        redirectUri: `http://127.0.0.1:${port}`,
        code,
        close: () => {
          if (done) return;
          finish();
          rejectCode(new Error('google: cancelled'));
        },
      });
    });
  });
}
