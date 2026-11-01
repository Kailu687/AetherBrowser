import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authUrl, exchangeCode, isValidClientId, loopback, pkcePair } from '../src/oauth';
import { uploadSync } from '../src/drive';

describe('google oauth', () => {
  it('builds a PKCE pair and auth url', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    const u = new URL(authUrl({ clientId: '1-a.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:5', challenge, state: 's' }));
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toContain('drive.appdata');
    expect(u.searchParams.get('scope')).not.toContain('auth/drive ');
  });
  it('validates client ids', () => {
    expect(isValidClientId('123-abc.apps.googleusercontent.com')).toBe(true);
    expect(isValidClientId('evil.example.com')).toBe(false);
  });
  it('loopback accepts only the matching state', async () => {
    const lb = await loopback({ state: 'good' });
    const bad = await fetch(`${lb.redirectUri}/?code=x&state=bad`);
    expect(bad.status).toBe(400);
    await expect(lb.code).rejects.toThrow(/state/);
    const lb2 = await loopback({ state: 'good' });
    expect((await fetch(`${lb2.redirectUri}/?code=abc&state=good`)).status).toBe(200);
    await expect(lb2.code).resolves.toBe('abc');
  });
  it('exchanges a code and reports google errors', async () => {
    const f = async (_u: string, init?: RequestInit) => {
      const b = new URLSearchParams(String(init?.body));
      expect(b.get('code_verifier')).toBe('v');
      return new Response(JSON.stringify({ access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'openid' }));
    };
    const t = await exchangeCode(f, { clientId: 'c' }, 'code', 'v', 'http://127.0.0.1:1');
    expect(t.refreshToken).toBe('r');
    const bad = async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    await expect(exchangeCode(bad, { clientId: 'c' }, 'code', 'v', 'x')).rejects.toThrow(/invalid_grant/);
  });
  it('creates the sync file in appDataFolder', async () => {
    const calls: string[] = [];
    const f = async (u: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${u.split('?')[0]}`);
      if (u.includes('spaces=appDataFolder')) return new Response(JSON.stringify({ files: [] }));
      expect(String(init?.body)).toContain('"parents":["appDataFolder"]');
      return new Response(JSON.stringify({ id: 'f1' }));
    };
    expect(await uploadSync(f, 't', { a: 1 })).toBe('f1');
    expect(calls[1]).toBe('POST https://www.googleapis.com/upload/drive/v3/files');
  });
});
