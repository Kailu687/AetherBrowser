import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { app, session, type Session } from 'electron';
import type { SessionContext } from '@aether/plugin-api';
import type { AetherStore } from '@aether/storage';
import type { InternalPages } from './internal-pages';

/** Permissions granted without asking (harmless or user-initiated). */
const ALWAYS_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'window-management']);
/** Permissions we prompt for and remember per profile + origin. */
const PROMPTABLE = new Set(['media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'clipboard-read', 'display-capture', 'idle-detection', 'speaker-selection']);

export interface PermissionRouter {
  /** Asks the UI that owns this WebContents. Resolves to the user's answer. */
  ask(webContentsId: number, origin: string, permission: string): Promise<{ allow: boolean; remember: boolean }>;
}

export interface SessionSetupHooks {
  onCreated(session: Session, ctx: SessionContext): void;
  onDownload(session: Session, ctx: SessionContext): void;
  onExtensions?(session: Session, ctx: SessionContext): Promise<void>;
}

/**
 * Builds a Chrome-compatible user agent. Electron's default UA advertises
 * "Electron/x" and the app name, which some sites (including Google sign-in)
 * treat as an embedded, untrusted browser. We do not spoof another vendor;
 * we present the underlying Chromium version truthfully.
 */
export function chromeUserAgent(defaultUa: string): string {
  return defaultUa
    .replace(/\s?Electron\/[\d.]+/i, '')
    .replace(/\s?aether\/[\d.]+/i, '')
    .replace(/\s?@aether\/desktop\/[\d.]+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Owns Electron sessions. Every profile gets its own persistent partition
 * (separate cookies, cache, storage, service workers, permissions); every
 * private window gets a fresh in-memory partition that dies with the window.
 */
export class SessionRegistry {
  private bySession = new Map<Session, SessionContext>();
  private profileSessions = new Map<string, Session>();

  constructor(
    private store: AetherStore,
    private pages: InternalPages,
    private permissions: PermissionRouter,
    private hooks: SessionSetupHooks,
  ) {}

  static partitionForProfile(profileId: string): string {
    return `persist:profile-${profileId}`;
  }

  forProfile(profileId: string): Session {
    const existing = this.profileSessions.get(profileId);
    if (existing) return existing;
    const partition = SessionRegistry.partitionForProfile(profileId);
    const ses = session.fromPartition(partition, { cache: true });
    this.setup(ses, { profileId, partition, isPrivate: false });
    this.profileSessions.set(profileId, ses);
    return ses;
  }

  createPrivate(profileId: string): Session {
    const partition = `private-${randomUUID()}`;
    const ses = session.fromPartition(partition, { cache: false });
    this.setup(ses, { profileId, partition, isPrivate: true });
    return ses;
  }

  async disposePrivate(ses: Session): Promise<void> {
    const ctx = this.bySession.get(ses);
    if (!ctx?.isPrivate) return;
    this.bySession.delete(ses);
    try {
      await ses.clearStorageData();
      await ses.clearCache();
      await ses.clearAuthCache();
    } catch {
      /* best effort; the partition is in-memory anyway */
    }
  }

  context(ses: Session): SessionContext | undefined {
    return this.bySession.get(ses);
  }

  all(): [Session, SessionContext][] {
    return [...this.bySession.entries()];
  }

  /**
   * Wipes a profile's engine data (cookies, storage, cache) and returns the
   * on-disk partition directory so it can be removed once no longer locked.
   */
  async wipeProfile(profileId: string): Promise<string | null> {
    const ses = this.profileSessions.get(profileId) ?? session.fromPartition(SessionRegistry.partitionForProfile(profileId));
    const dir = ses.storagePath ?? null;
    try {
      await ses.clearStorageData();
      await ses.clearCache();
      await ses.clearAuthCache();
      await ses.clearHostResolverCache();
    } catch {
      /* continue; directory removal on next launch is the backstop */
    }
    this.profileSessions.delete(profileId);
    this.bySession.delete(ses);
    return dir;
  }

  private setup(ses: Session, ctx: SessionContext): void {
    this.bySession.set(ses, ctx);
    ses.setUserAgent(chromeUserAgent(ses.getUserAgent()), app.getLocale());
    try {
      ses.setSpellCheckerLanguages(ses.availableSpellCheckerLanguages.includes(app.getLocale()) ? [app.getLocale()] : ['en-US']);
    } catch {
      /* spellchecker unavailable on some platforms */
    }

    // Content hook for cosmetic filtering. Sandboxed and isolated; it exposes nothing to pages.
    try {
      ses.registerPreloadScript({ type: 'frame', id: 'aether-content', filePath: join(__dirname, 'content.cjs') });
    } catch (err) {
      console.warn('[sessions] content preload unavailable', err);
    }

    // Internal pages, unprivileged, per-session so they know the profile.
    ses.protocol.handle('aether', (req) => this.pages.handle(req.url, ctx));

    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const origin = originOf(details.requestingUrl || wc?.getURL() || '');
      if (ALWAYS_ALLOW.has(permission)) return callback(true);
      if (!origin || !PROMPTABLE.has(permission) || !wc) return callback(false);
      const stored = ctx.isPrivate ? null : this.store.getPermission(ctx.profileId, origin, permission);
      if (stored) return callback(stored === 'allow');
      this.permissions
        .ask(wc.id, origin, permission)
        .then(({ allow, remember }) => {
          if (remember && !ctx.isPrivate) this.store.setPermission(ctx.profileId, origin, permission, allow ? 'allow' : 'deny');
          callback(allow);
        })
        .catch(() => callback(false));
    });

    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      if (ALWAYS_ALLOW.has(permission)) return true;
      if (ctx.isPrivate || !PROMPTABLE.has(permission)) return false;
      return this.store.getPermission(ctx.profileId, originOf(requestingOrigin), permission) === 'allow';
    });

    // Device pickers (WebUSB/HID/Serial) are useful for engineers but need a
    // picker UI; until it exists, deny rather than silently auto-select.
    ses.setDevicePermissionHandler(() => false);

    this.hooks.onDownload(ses, ctx);
    this.hooks.onCreated(ses, ctx);
    if (!ctx.isPrivate) void this.hooks.onExtensions?.(ses, ctx);
  }
}
