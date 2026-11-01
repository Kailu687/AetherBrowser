import type { ModuleManifest, ModulePermission } from '@aether/plugin-api';

export type { ModuleManifest, ModulePermission };

/** How each permission is explained in the Module Store's approval sheet. */
export function describePermission(p: ModulePermission): { label: string; risk: 'low' | 'medium' | 'high'; detail: string } {
  if (p === 'net:localhost') return { label: 'Connect to servers on this PC', risk: 'low', detail: 'http://localhost only, for apps you run yourself.' };
  if (p === 'net:user') return { label: 'Connect to addresses you type', risk: 'medium', detail: 'AETHER asks you the first time it contacts each new address.' };
  if (p.startsWith('net:')) {
    const host = p.slice(4);
    return { label: `Connect to ${host}`, risk: 'low', detail: 'Only this host, over HTTPS, when you use a feature that needs it.' };
  }
  const table: Record<string, { label: string; risk: 'low' | 'medium' | 'high'; detail: string }> = {
    storage: { label: 'Keep its own data', risk: 'low', detail: 'A separate database and folder for this module only.' },
    'tabs.read': { label: 'Read the page you are on', risk: 'low', detail: 'Only when you click a button such as “Save offline” or “Clip”. Never cookies, passwords or form data.' },
    'files.pick': { label: 'Open and save files you choose', risk: 'medium', detail: 'Only the file you pick in a dialog.' },
    'files.folder': { label: 'Work inside folders you choose', risk: 'medium', detail: 'Read and write only inside a folder you pick in a dialog.' },
    'process.run': { label: 'Run programs installed on this PC', risk: 'high', detail: 'For example ngspice or a compiler. You approve each program the first time; every run has a time limit and no shell.' },
    'process.servers': { label: 'Run terminal commands and servers', risk: 'high', detail: 'Commands you type and dev servers you start, until you stop them or close AETHER.' },
    'ai.optional': { label: 'Use AI if you turned it on', risk: 'low', detail: 'Goes through your AI settings and consent; does nothing while AI is off.' },
    secrets: { label: 'Store API keys', risk: 'low', detail: 'Encrypted with your Windows account, visible only to this module.' },
  };
  return table[p] ?? { label: p, risk: 'high', detail: 'Unknown permission (will not be granted).' };
}

export const KNOWN_PERMISSIONS = ['storage', 'tabs.read', 'files.pick', 'files.folder', 'process.run', 'process.servers', 'ai.optional', 'secrets'];

export function isKnownPermission(p: string): p is ModulePermission {
  return KNOWN_PERMISSIONS.includes(p) || p === 'net:localhost' || p === 'net:user' || /^net:(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(p);
}

export const MODULE_ID_RE = /^aether\.module\.[a-z][a-z0-9-]{0,30}$/;
const CATEGORIES = ['research', 'electronics', 'developer', 'software', 'mechanical', 'aerospace', 'civil', 'bio', 'rf', 'data', 'math', 'other'];
const OSES = ['win32', 'darwin', 'linux'];

/** Manifest validation (schema 2). The security package adds signature and file integrity checks. */
export function validateManifest(m: ModuleManifest): string[] {
  const errs: string[] = [];
  if (!m || typeof m !== 'object') return ['manifest missing'];
  if (m.manifest !== 2) errs.push('manifest must be 2');
  if (!MODULE_ID_RE.test(m.id)) errs.push(`bad id ${m.id} (want aether.module.<name>)`);
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60) errs.push('name required (max 60 chars)');
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(m.version)) errs.push('version must be semver');
  if (m.layer !== 'module') errs.push("layer must be 'module'");
  if (!CATEGORIES.includes(m.category)) errs.push(`unknown category ${m.category}`);
  if (!m.engines?.aether) errs.push('engines.aether required');
  if (typeof m.license !== 'string' || !/^[A-Za-z0-9.+-]+( (AND|OR) [A-Za-z0-9.+-]+)*$/.test(m.license)) errs.push('license (SPDX id) required');
  if (m.os && (!Array.isArray(m.os) || m.os.some((o) => !OSES.includes(o)))) errs.push('os must list win32/darwin/linux');
  if (!Array.isArray(m.permissions)) errs.push('permissions must be an array');
  for (const p of m.permissions ?? []) if (!isKnownPermission(p)) errs.push(`unknown permission ${p}`);
  if (m.network === 'none' && (m.permissions ?? []).some((p) => p.startsWith('net:') && p !== 'net:localhost')) errs.push("network 'none' but asks for internet hosts");
  if (!m.limits?.length) errs.push('limits must list what the module cannot do');
  if (!m.apps?.length && !m.features?.length) errs.push('a module needs apps or features');
  for (const a of m.apps ?? []) if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(a.id)) errs.push(`bad app id ${a.id}`);
  for (const d of Object.keys(m.dependencies ?? {})) if (!MODULE_ID_RE.test(d)) errs.push(`bad dependency id ${d}`);
  for (const x of m.externalApps ?? []) if (!/^[A-Za-z0-9._+-]{1,64}$/.test(x.program)) errs.push(`bad external program ${x.program}`);
  return errs;
}

// ---------------------------------------------------------------------------- semver ranges

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/** Supports space-separated comparators (>=, >, <=, <, =), ^x.y.z, ~x.y.z, x.y.z and * . */
export function satisfies(version: string, range: string): boolean {
  const r = range.trim();
  if (!r || r === '*') return true;
  return r.split(/\s+/).every((c) => {
    const m = c.match(/^(>=|<=|>|<|=|\^|~)?v?(\d+(?:\.\d+){0,2})$/);
    if (!m) return false;
    const [maj, min = 0, pat = 0] = m[2].split('.').map(Number);
    const base = `${maj}.${min}.${pat}`;
    const cmp = compareVersions(version, base);
    switch (m[1]) {
      case '>=': return cmp >= 0;
      case '>': return cmp > 0;
      case '<=': return cmp <= 0;
      case '<': return cmp < 0;
      case '^': return cmp >= 0 && (maj > 0 ? compareVersions(version, `${maj + 1}.0.0`) < 0 : compareVersions(version, `0.${min + 1}.0`) < 0);
      case '~': return cmp >= 0 && compareVersions(version, `${maj}.${min + 1}.0`) < 0;
      default: return cmp === 0;
    }
  });
}
