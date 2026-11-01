import { describe, expect, it } from 'vitest';
import type { ModuleManifest } from '@aether/plugin-api';
import { ModuleRegistry, brokerFor, manifestDigest, satisfies, STUDIO, validateManifest, compareVersions } from '../src/index.js';

const base = (id: string, extra: Partial<ModuleManifest> = {}): ModuleManifest => ({
  manifest: 2, id: `aether.module.${id}`, name: `${id} Module`, version: '1.0.0', layer: 'module', license: 'MIT', category: 'other', icon: 'x', color: '#000', tagline: '', description: '',
  engines: { aether: '>=0.4.0' }, permissions: [], network: 'none', features: [], limits: ['test'], apps: [{ id: `${id}.app`, title: 'A', icon: 'a', description: '' }], ...extra,
});
const CAT = [
  base('dev', { permissions: ['files.folder', 'process.run', 'process.servers'] }),
  base('mech'),
  base('civil', { dependencies: { 'aether.module.mech': '^1.0.0' } }),
  base('future', { engines: { aether: '>=0.9.0' } }),
  base('net', { permissions: ['net:api.openalex.org', 'tabs.read'] }),
];
function kv() {
  const m = new Map<string, unknown>();
  return { get: (k: string, p?: string) => m.get(`${p}:${k}`) as never, set: (k: string, v: unknown, p?: string) => void m.set(`${p}:${k}`, v), m };
}

describe('module registry', () => {
  it('disables without uninstalling, honours OS lists and safe mode', () => {
    const cat = [...CAT, base('winonly', { os: ['darwin'] })];
    const store = kv();
    const r = new ModuleRegistry(store, '0.4.0', cat, () => 1, false, 'win32');
    r.install('a', 'aether.module.mech', []);
    r.install('a', 'aether.module.civil', []);
    expect(() => r.setEnabled('a', 'aether.module.mech', false)).toThrow(/civil Module/);
    r.setEnabled('a', 'aether.module.civil', false);
    expect(r.isActive('a', 'aether.module.civil')).toBe(false);
    expect(r.isInstalled('a', 'aether.module.civil')).toBe(true);
    expect(r.granted('a', 'aether.module.civil', 'storage')).toBe(false);
    r.setEnabled('a', 'aether.module.civil', true);
    expect(r.isActive('a', 'aether.module.civil')).toBe(true);
    expect(() => r.install('a', 'aether.module.winonly', [])).toThrow(/operating system/);
    const safe = new ModuleRegistry(store, '0.4.0', cat, () => 1, true, 'win32');
    expect(safe.isActive('a', 'aether.module.mech')).toBe(false);
    expect(safe.isInstalled('a', 'aether.module.mech')).toBe(true);
  });
  it('installs per profile only when every permission is approved', () => {
    const r = new ModuleRegistry(kv(), '0.4.0', CAT, () => 5);
    expect(() => r.install('a', 'aether.module.dev', [])).toThrow(/Approve all/);
    r.install('a', 'aether.module.dev', ['files.folder', 'process.run', 'process.servers']);
    expect(r.granted('a', 'aether.module.dev', 'process.run')).toBe(true);
    expect(r.granted('a', 'aether.module.dev', 'tabs.read')).toBe(false);
    expect(r.granted('b', 'aether.module.dev', 'process.run')).toBe(false);
    r.uninstall('a', 'aether.module.dev');
    expect(r.granted('a', 'aether.module.dev', 'process.run')).toBe(false);
  });
  it('enforces compatibility and dependencies', () => {
    const r = new ModuleRegistry(kv(), '0.4.0', CAT);
    expect(() => r.install('a', 'aether.module.future', [])).toThrow(/needs AETHER/);
    expect(() => r.install('a', 'aether.module.civil', [])).toThrow(/mech Module first/);
    r.install('a', 'aether.module.mech', []);
    r.install('a', 'aether.module.civil', []);
    expect(() => r.uninstall('a', 'aether.module.mech')).toThrow(/civil Module/);
  });
  it('flags changed manifests and keeps only previously approved permissions', () => {
    const store = kv();
    store.set('installed', [{ id: 'aether.module.net', version: '0.9.0', installedAt: 1, permissions: ['tabs.read'], digest: 'old' }], 'a');
    const r = new ModuleRegistry(store, '0.4.0', CAT);
    expect(r.status('a').find((s) => s.pack.id === 'aether.module.net')!.needsReview).toBe(true);
    expect(r.granted('a', 'aether.module.net', 'tabs.read')).toBe(true);
    expect(r.granted('a', 'aether.module.net', 'net:api.openalex.org')).toBe(false);
  });
  it('studio consent and the broker', () => {
    const r = new ModuleRegistry(kv(), '0.4.0', CAT);
    const b = brokerFor(() => r);
    expect(() => b.require('a', STUDIO, 'process.run')).toThrow('permission-required:studio:process.run');
    r.setStudioConsent('a', 'process.run', true);
    expect(() => b.require('a', STUDIO, 'process.run')).not.toThrow();
    expect(brokerFor(() => null).granted('a', STUDIO, 'process.run')).toBe(false);
  });
  it('validates manifests and semver ranges', () => {
    expect(validateManifest(CAT[0])).toEqual([]);
    expect(validateManifest(base('x', { id: 'bad', permissions: ['cookies' as never] }))).toHaveLength(2);
    expect(manifestDigest(CAT[0])).toMatch(/^[0-9a-f]{16}$/);
    expect(manifestDigest({ ...CAT[0], permissions: [] })).not.toBe(manifestDigest(CAT[0]));
    expect(satisfies('0.4.0', '>=0.4.0 <0.6.0')).toBe(true);
    expect(satisfies('0.6.0', '>=0.4.0 <0.6.0')).toBe(false);
    expect(satisfies('1.2.3', '^1.0.0')).toBe(true);
    expect(satisfies('2.0.0', '^1.0.0')).toBe(false);
    expect(satisfies('0.4.5', '^0.4.0')).toBe(true);
    expect(satisfies('0.5.0', '~0.4.0')).toBe(false);
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
  });
});
