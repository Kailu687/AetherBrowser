import type { ModuleManifest, ModulePermission } from '@aether/plugin-api';
import { compareVersions, isKnownPermission, satisfies } from './catalog.js';

type Permission = ModulePermission;
type AddonPack = ModuleManifest;

export interface InstalledModule {
  id: string;
  version: string;
  installedAt: number;
  /** Permissions the user approved at install (or later review). */
  permissions: Permission[];
  /** Digest of the manifest the user approved; a mismatch means it changed and needs review. */
  digest: string;
  /** Disabled modules stay installed (data and approvals kept) but their IPC and apps are off. */
  enabled: boolean;
}

export interface KvLike {
  get<T = unknown>(key: string, profileId?: string): T | undefined;
  set(key: string, value: unknown, profileId?: string): void;
  delete?(key: string, profileId?: string): void;
}

/** Owner for Studio apps (Code, Writer) that ask for consent at first use instead of at install. */
export const STUDIO = 'studio';

const KEY = 'installed';
const CONSENT = 'studio-consent';

/** Stable digest of the security-relevant parts of a manifest (FNV-1a, isomorphic, no deps). */
export function manifestDigest(p: Pick<AddonPack, 'id' | 'version' | 'permissions' | 'engines' | 'dependencies'>): string {
  const deps = Object.entries(p.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const canon = JSON.stringify({ id: p.id, version: p.version, permissions: [...p.permissions].sort(), engines: p.engines.aether, deps });
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < canon.length; i++) {
    const c = canon.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 + i) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export class ModuleError extends Error {
  constructor(message: string, readonly code: 'unknown' | 'incompatible' | 'unsupported-os' | 'missing-deps' | 'needed-by' | 'permission' | 'safe-mode', readonly detail?: string[]) {
    super(message);
  }
}

export interface ModuleStatus {
  pack: AddonPack;
  installed: InstalledModule | null;
  compatible: boolean;
  /** False when the manifest's `os` list excludes this OS. */
  osSupported: boolean;
  /** Installed, enabled and not in safe mode. */
  active: boolean;
  /** Installed, but its manifest changed (new version or new permissions) since approval. */
  needsReview: boolean;
  missingDeps: string[];
}

/**
 * Which Modules a profile has installed and which permissions the user approved.
 * The registry is the single source of truth other modules ask (via the
 * broker) before doing anything a Module's manifest had to request.
 */
export class ModuleRegistry {
  private byId: Map<string, AddonPack>;
  constructor(
    private kv: KvLike,
    private appVersion: string,
    readonly catalog: AddonPack[],
    private now: () => number = Date.now,
    /** Safe mode: every module is treated as off (nothing is uninstalled). */
    readonly safeMode = false,
    private platform: string = typeof process !== 'undefined' ? process.platform : 'win32',
  ) {
    this.byId = new Map(catalog.map((m) => [m.id, m]));
  }

  getPack(id: string): AddonPack | undefined {
    return this.byId.get(id);
  }

  private raw(profileId: string): InstalledModule[] {
    return (this.kv.get<InstalledModule[]>(KEY, profileId) ?? []).map((p) => ({ ...p, permissions: p.permissions ?? [], digest: p.digest ?? '', enabled: p.enabled ?? true }));
  }

  installed(profileId: string): InstalledModule[] {
    return this.raw(profileId).filter((p) => this.getPack(p.id));
  }

  isInstalled(profileId: string, id: string): boolean {
    return this.installed(profileId).some((p) => p.id === id);
  }

  /** Installed, enabled, supported here and not in safe mode: its IPC and apps may run. */
  isActive(profileId: string, id: string): boolean {
    if (this.safeMode) return false;
    const pack = this.getPack(id);
    return !!pack && this.osOk(pack) && this.installed(profileId).some((p) => p.id === id && p.enabled);
  }

  private osOk(pack: AddonPack): boolean {
    return !pack.os?.length || pack.os.includes(this.platform as 'win32');
  }

  /** Turns an installed module off or on without losing its data or approvals. */
  setEnabled(profileId: string, id: string, enabled: boolean): void {
    const list = this.installed(profileId);
    const rec = list.find((p) => p.id === id);
    if (!rec) throw new ModuleError('That module is not installed.', 'unknown');
    if (!enabled) {
      const dependents = list.filter((p) => p.enabled && !!this.getPack(p.id)?.dependencies?.[id]);
      if (dependents.length) throw new ModuleError(`Turn off ${dependents.map((d) => this.getPack(d.id)!.name).join(', ')} first; it builds on this module.`, 'needed-by', dependents.map((d) => d.id));
    } else {
      const missing = this.missingDeps(this.getPack(id)!, list.filter((p) => p.enabled));
      if (missing.length) throw new ModuleError(`Turn on ${missing.map((m) => this.getPack(m)?.name ?? m).join(', ')} first.`, 'missing-deps', missing);
    }
    this.kv.set(KEY, list.map((p) => (p.id === id ? { ...p, enabled } : p)), profileId);
  }

  status(profileId: string): ModuleStatus[] {
    const inst = this.installed(profileId);
    return this.catalog.map((pack) => {
      const installed = inst.find((p) => p.id === pack.id) ?? null;
      return {
        pack,
        installed,
        compatible: satisfies(this.appVersion, pack.engines.aether),
        osSupported: this.osOk(pack),
        active: this.isActive(profileId, pack.id),
        needsReview: !!installed && installed.digest !== manifestDigest(pack),
        missingDeps: this.missingDeps(pack, inst),
      };
    });
  }

  /** Installs (or re-approves) a Module. `approved` must list every permission in the manifest. */
  install(profileId: string, id: string, approved: Permission[]): InstalledModule {
    const pack = this.getPack(id);
    if (!pack) throw new ModuleError(`Unknown module: ${id}`, 'unknown');
    if (!this.osOk(pack)) throw new ModuleError(`${pack.name} does not support this operating system.`, 'unsupported-os');
    if (!satisfies(this.appVersion, pack.engines.aether)) throw new ModuleError(`${pack.name} needs AETHER ${pack.engines.aether} (this is ${this.appVersion}).`, 'incompatible');
    const unknown = pack.permissions.filter((p) => !isKnownPermission(p));
    if (unknown.length) throw new ModuleError(`${pack.name} asks for permissions AETHER does not grant: ${unknown.join(', ')}`, 'permission', unknown);
    const list = this.installed(profileId);
    const missing = this.missingDeps(pack, list);
    if (missing.length) throw new ModuleError(`${pack.name} needs ${missing.map((m) => this.getPack(m)?.name ?? m).join(', ')} first.`, 'missing-deps', missing);
    const notApproved = pack.permissions.filter((p) => p !== 'storage' && !approved.includes(p));
    if (notApproved.length) throw new ModuleError(`Approve all requested permissions to install ${pack.name}.`, 'permission', notApproved);
    const rec: InstalledModule = { id, version: pack.version, installedAt: list.find((p) => p.id === id)?.installedAt ?? this.now(), permissions: [...pack.permissions], digest: manifestDigest(pack), enabled: list.find((p) => p.id === id)?.enabled ?? true };
    this.kv.set(KEY, [...list.filter((p) => p.id !== id), rec], profileId);
    return rec;
  }

  private missingDeps(pack: AddonPack, inst: InstalledModule[]): string[] {
    return Object.entries(pack.dependencies ?? {})
      .filter(([dep, range]) => {
        const rec = inst.find((p) => p.id === dep);
        return !rec || !satisfies(rec.version, range);
      })
      .map(([dep]) => dep);
  }

  uninstall(profileId: string, id: string): void {
    const list = this.installed(profileId);
    const dependents = list.filter((p) => !!this.getPack(p.id)?.dependencies?.[id]);
    if (dependents.length) throw new ModuleError(`Remove ${dependents.map((d) => this.getPack(d.id)!.name).join(', ')} first; it builds on this module.`, 'needed-by', dependents.map((d) => d.id));
    this.kv.set(KEY, list.filter((p) => p.id !== id), profileId);
  }

  /** Does `owner` (a Module id, or STUDIO) hold `perm` for this profile right now? */
  granted(profileId: string, owner: string, perm: Permission): boolean {
    if (owner === STUDIO) return (this.kv.get<Permission[]>(CONSENT, profileId) ?? []).includes(perm);
    if (!this.isActive(profileId, owner)) return false;
    const rec = this.installed(profileId).find((p) => p.id === owner);
    const pack = this.getPack(owner);
    if (!rec || !pack) return false;
    if (perm === 'storage') return true;
    // A changed manifest keeps only the permissions that were approved before.
    return rec.permissions.includes(perm) && pack.permissions.includes(perm);
  }

  /** Studio apps ask at first use ("Allow AETHER to run programs on this PC?"). */
  setStudioConsent(profileId: string, perm: Permission, allow: boolean): Permission[] {
    if (!isKnownPermission(perm)) throw new ModuleError('Unknown permission', 'permission');
    const cur = (this.kv.get<Permission[]>(CONSENT, profileId) ?? []).filter((p) => p !== perm);
    const next = allow ? [...cur, perm] : cur;
    this.kv.set(CONSENT, next, profileId);
    return next;
  }

  studioConsent(profileId: string): Permission[] {
    return this.kv.get<Permission[]>(CONSENT, profileId) ?? [];
  }
}

/**
 * What other main-process modules get: a read-only check plus a guard that
 * throws a PermissionDenied error the UI can turn into a prompt.
 */
export interface PermissionBroker {
  /** Module installed, enabled and not in safe mode. */
  active(profileId: string, moduleId: string): boolean;
  granted(profileId: string, owner: string, perm: Permission): boolean;
  /** Throws `permission-required:<owner>:<perm>` unless granted. Private windows use the parent profile's grants. */
  require(profileId: string, owner: string, perm: Permission): void;
}

export function brokerFor(getRegistry: () => ModuleRegistry | null): PermissionBroker {
  return {
    active: (profileId, id) => getRegistry()?.isActive(profileId, id) ?? false,
    granted: (profileId, owner, perm) => getRegistry()?.granted(profileId, owner, perm) ?? false,
    require(profileId, owner, perm) {
      if (!getRegistry()?.granted(profileId, owner, perm)) throw new Error(`permission-required:${owner}:${perm}`);
    },
  };
}


/** @deprecated v1 names. */
export { ModuleRegistry as AddonRegistry, ModuleError as AddonError };
export type { InstalledModule as InstalledPack, ModuleStatus as PackStatus };
