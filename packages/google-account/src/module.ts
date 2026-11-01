import { randomBytes } from 'node:crypto';
import type { AetherMainModule, MainHost } from '@aether/plugin-api';
import { authUrl, exchangeCode, GOOGLE_USERINFO, isValidClientId, loopback, pkcePair, refreshTokens, revoke, type GoogleClient } from './oauth.js';
import { deleteSync, downloadSync, uploadSync } from './drive.js';

export const GOOGLE_MODULE_ID = 'aether.google';

export interface GoogleAccount {
  email: string;
  name?: string;
  picture?: string;
  connectedAt: number;
  lastPush?: number;
  lastPull?: number;
}

export interface GoogleStatus {
  configured: boolean;
  clientId: string | null;
  hasSecret: boolean;
  encryption: boolean;
  account: GoogleAccount | null;
  pending: boolean;
  isPrivate: boolean;
}

/**
 * Core: "Connect Google". Uses the user's own OAuth client (Desktop app type),
 * the system browser with a loopback redirect and PKCE, and stores the refresh
 * token encrypted with the OS keychain. Tokens never leave the main process:
 * the UI and Labs only ever see the account's email, name and picture.
 */
export function createGoogleModule(): AetherMainModule {
  return {
    id: GOOGLE_MODULE_ID,
    activate(host: MainHost) {
      const kv = host.storage.kv;
      const secrets = host.secrets;
      const fetch = (url: string, init?: RequestInit) => host.net.fetch(url, init);
      const access = new Map<string, { token: string; expiresAt: number }>();
      const pending = new Map<string, () => void>();

      const client = (): GoogleClient | null => {
        const clientId = kv.get<string>('clientId');
        if (!clientId) return null;
        return { clientId, clientSecret: secrets?.get('clientSecret') ?? undefined };
      };
      const account = (profileId: string) => kv.get<GoogleAccount>('account', profileId) ?? null;
      const status = (profileId: string, isPrivate: boolean): GoogleStatus => ({
        configured: !!client(),
        clientId: kv.get<string>('clientId') ?? null,
        hasSecret: !!secrets?.get('clientSecret'),
        encryption: !!secrets?.available,
        account: isPrivate ? null : account(profileId),
        pending: pending.has(profileId),
        isPrivate,
      });
      const changed = (profileId: string) => host.ipc.emit('changed', { profileId });
      const noPrivate = (isPrivate: boolean) => {
        if (isPrivate) throw new Error('Google sign-in is not available in private windows');
      };

      const token = async (profileId: string): Promise<string> => {
        const cached = access.get(profileId);
        if (cached && cached.expiresAt > Date.now()) return cached.token;
        const c = client();
        const refresh = secrets?.get(`refresh:${profileId}`);
        if (!c || !refresh) throw new Error('Google account is not connected');
        const t = await refreshTokens(fetch, c, refresh);
        access.set(profileId, { token: t.accessToken, expiresAt: t.expiresAt });
        return t.accessToken;
      };

      host.ipc.handle('status', (_p, ctx) => status(ctx.profileId, ctx.isPrivate));

      host.ipc.handle('configure', (p, ctx) => {
        const { clientId, clientSecret } = (p ?? {}) as { clientId?: unknown; clientSecret?: unknown };
        if (typeof clientId !== 'string' || !isValidClientId(clientId)) throw new Error('That does not look like a Google OAuth client ID (…apps.googleusercontent.com)');
        if (clientSecret !== undefined && (typeof clientSecret !== 'string' || clientSecret.length > 200)) throw new Error('Invalid client secret');
        if (!secrets?.available) throw new Error('This system offers no OS encryption, so AETHER will not store Google credentials');
        kv.set('clientId', clientId.trim());
        if (typeof clientSecret === 'string' && clientSecret.trim()) secrets.set('clientSecret', clientSecret.trim());
        else if (clientSecret === '') secrets.delete('clientSecret');
        changed(ctx.profileId);
        return status(ctx.profileId, ctx.isPrivate);
      });

      host.ipc.handle('signIn', async (_p, ctx) => {
        noPrivate(ctx.isPrivate);
        const c = client();
        if (!c) throw new Error('Add your Google OAuth client ID first');
        if (!secrets?.available) throw new Error('OS encryption unavailable; refusing to store Google tokens');
        if (!host.openExternal) throw new Error('System browser unavailable');
        pending.get(ctx.profileId)?.();
        const state = randomBytes(24).toString('hex');
        const { verifier, challenge } = pkcePair();
        const lb = await loopback({ state });
        pending.set(ctx.profileId, lb.close);
        changed(ctx.profileId);
        try {
          await host.openExternal(authUrl({ clientId: c.clientId, redirectUri: lb.redirectUri, challenge, state }));
          const code = await lb.code;
          const t = await exchangeCode(fetch, c, code, verifier, lb.redirectUri);
          if (!t.refreshToken) throw new Error('Google did not return a refresh token; remove AETHER from your Google account permissions and try again');
          if (!t.scope?.includes('drive.appdata')) host.log.warn('Drive appData scope not granted; sync will be unavailable');
          const info = (await (await fetch(GOOGLE_USERINFO, { headers: { authorization: `Bearer ${t.accessToken}` } })).json()) as { email?: string; name?: string; picture?: string };
          if (!info.email) throw new Error('Google did not share an email address');
          secrets.set(`refresh:${ctx.profileId}`, t.refreshToken);
          access.set(ctx.profileId, { token: t.accessToken, expiresAt: t.expiresAt });
          kv.set('account', { email: info.email, name: info.name, picture: typeof info.picture === 'string' && info.picture.startsWith('https://') ? info.picture : undefined, connectedAt: Date.now() } satisfies GoogleAccount, ctx.profileId);
          host.log.info(`google connected for profile ${ctx.profileId}`);
          return status(ctx.profileId, false);
        } finally {
          lb.close();
          pending.delete(ctx.profileId);
          changed(ctx.profileId);
        }
      });

      host.ipc.handle('cancel', (_p, ctx) => {
        pending.get(ctx.profileId)?.();
        return status(ctx.profileId, ctx.isPrivate);
      });

      const disconnect = async (profileId: string) => {
        const refresh = secrets?.get(`refresh:${profileId}`);
        if (refresh) await revoke(fetch, refresh);
        secrets?.delete(`refresh:${profileId}`);
        access.delete(profileId);
        kv.delete('account', profileId);
      };

      host.ipc.handle('disconnect', async (p, ctx) => {
        noPrivate(ctx.isPrivate);
        if ((p as { deleteCloudCopy?: unknown })?.deleteCloudCopy === true) {
          await deleteSync(fetch, await token(ctx.profileId)).catch((e: Error) => host.log.warn(e.message));
        }
        await disconnect(ctx.profileId);
        changed(ctx.profileId);
        return status(ctx.profileId, false);
      });

      host.ipc.handle('sync.push', async (_p, ctx) => {
        noPrivate(ctx.isPrivate);
        if (!host.shellData) throw new Error('Sync unavailable');
        const data = host.shellData.exportSyncData(ctx.profileId);
        await uploadSync(fetch, await token(ctx.profileId), data);
        const a = account(ctx.profileId);
        if (a) kv.set('account', { ...a, lastPush: Date.now() }, ctx.profileId);
        changed(ctx.profileId);
        return { ok: true, at: Date.now() };
      });

      host.ipc.handle('sync.pull', async (_p, ctx) => {
        noPrivate(ctx.isPrivate);
        if (!host.shellData) throw new Error('Sync unavailable');
        const data = await downloadSync(fetch, await token(ctx.profileId));
        if (!data) return { ok: true, added: 0, empty: true };
        const r = host.shellData.importSyncData(ctx.profileId, data);
        const a = account(ctx.profileId);
        if (a) kv.set('account', { ...a, lastPull: Date.now() }, ctx.profileId);
        changed(ctx.profileId);
        return { ok: true, added: r.added };
      });

      host.events.on('profileDeleted', (e) => {
        const profileId = (e as { profileId?: string })?.profileId;
        if (profileId) void disconnect(profileId).catch(() => undefined);
      });
    },
  };
}
