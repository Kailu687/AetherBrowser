import type { AetherMainModule, MainHost } from '@aether/plugin-api';
import type { ModuleManifest, ModulePermission } from '@aether/plugin-api';
import { describePermission, isKnownPermission, validateManifest } from './catalog.js';

type Permission = ModulePermission;
import { ModuleError, ModuleRegistry, brokerFor, STUDIO, type PermissionBroker } from './state.js';
import { MODULE_ID_RE } from './catalog.js';

export const MODULES_MODULE_ID = 'aether.modules';
/** @deprecated */
export const ADDONS_MODULE_ID = MODULES_MODULE_ID;

function packId(payload: unknown): string {
  const id = (payload as { id?: unknown })?.id;
  if (typeof id !== 'string' || !MODULE_ID_RE.test(id)) throw new Error('Invalid module id');
  return id;
}

function perms(payload: unknown, key = 'approved'): Permission[] {
  const v = (payload as Record<string, unknown>)?.[key];
  if (!Array.isArray(v)) return [];
  return v.filter((p): p is Permission => typeof p === 'string' && isKnownPermission(p));
}

export interface ModuleManagerModule extends AetherMainModule {
  /** Shared with modules that perform privileged work for Modules or Studio apps. */
  broker: PermissionBroker;
}
/** @deprecated */
export type AddonsModule = ModuleManagerModule;

/**
 * Core module manager: install/uninstall/enable/disable Modules per profile, record approved
 * permissions, check compatibility and dependencies, and answer permission
 * questions for other modules.
 */
export function createModuleManager(opts: { appVersion: string; catalog: ModuleManifest[]; safeMode?: boolean | (() => boolean); onRestartSafeMode?: () => void }): ModuleManagerModule {
  let reg: ModuleRegistry | null = null;
  const catalog = opts.catalog.filter((m) => {
    const errs = validateManifest(m);
    if (errs.length) console.error(`[modules] rejected manifest ${m.id}: ${errs.join('; ')}`);
    return !errs.length;
  });
  return {
    id: MODULES_MODULE_ID,
    broker: brokerFor(() => reg),
    activate(host: MainHost) {
      const safeMode = typeof opts.safeMode === 'function' ? opts.safeMode() : !!opts.safeMode;
      reg = new ModuleRegistry(host.storage.kv, opts.appVersion, catalog, Date.now, safeMode);
      const r = reg;
      const state = (profileId: string) => ({
        catalog: r.status(profileId).map((s) => s.pack),
        status: r.status(profileId).map(({ pack, ...rest }) => ({ id: pack.id, ...rest })),
        installed: r.installed(profileId),
        studioConsent: r.studioConsent(profileId),
        permissions: Object.fromEntries([...new Set(catalog.flatMap((c) => c.permissions))].map((p) => [p, describePermission(p)])),
        appVersion: opts.appVersion,
        safeMode: r.safeMode,
        platform: process.platform,
      });
      const wrap = (fn: () => unknown) => {
        try {
          return fn();
        } catch (e) {
          if (e instanceof ModuleError) return { error: { message: e.message, code: e.code, detail: e.detail } };
          throw e;
        }
      };
      host.ipc.handle('state', (_p, ctx) => state(ctx.profileId));
      host.ipc.handle('install', (p, ctx) =>
        wrap(() => {
          r.install(ctx.profileId, packId(p), perms(p));
          host.ipc.emit('changed', { profileId: ctx.profileId });
          host.log.info(`installed ${packId(p)} for profile ${ctx.profileId}`);
          return state(ctx.profileId);
        }),
      );
      host.ipc.handle('uninstall', (p, ctx) =>
        wrap(() => {
          r.uninstall(ctx.profileId, packId(p));
          host.ipc.emit('changed', { profileId: ctx.profileId });
          return state(ctx.profileId);
        }),
      );
      host.ipc.handle('setEnabled', (p, ctx) =>
        wrap(() => {
          r.setEnabled(ctx.profileId, packId(p), (p as { enabled?: unknown }).enabled === true);
          host.ipc.emit('changed', { profileId: ctx.profileId });
          return state(ctx.profileId);
        }),
      );
      host.ipc.handle('restartSafeMode', async () => {
        if (!opts.onRestartSafeMode) throw new Error('Safe mode restart unavailable');
        opts.onRestartSafeMode();
        return true;
      });
      host.ipc.handle('consent', (p, ctx) => {
        const perm = perms({ approved: [(p as { permission?: unknown })?.permission] })[0];
        if (!perm) throw new Error('Invalid permission');
        r.setStudioConsent(ctx.profileId, perm, (p as { allow?: unknown }).allow === true);
        host.ipc.emit('changed', { profileId: ctx.profileId });
        return state(ctx.profileId);
      });
      host.ipc.handle('granted', (p, ctx) => r.granted(ctx.profileId, String((p as { owner?: unknown })?.owner ?? STUDIO), perms({ approved: [(p as { permission?: unknown })?.permission] })[0]));
      host.events.on('profileDeleted', ({ profileId }) => {
        host.storage.kv.delete('installed', profileId);
        host.storage.kv.delete('studio-consent', profileId);
      });
    },
  };
}

/** @deprecated */
export const createAddonsModule = createModuleManager;
