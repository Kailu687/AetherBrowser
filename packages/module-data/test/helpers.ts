import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMainModule } from '../src/module.js';
import { mulberry32, gaussian } from '../src/rng.js';
import type { Table } from '../src/table.js';

/** Two-class data: label = 1 when 2x - y + noise > 0; plus a categorical colour that shifts the odds. */
export function synthClassification(n = 600, seed = 1): Table {
  const r = mulberry32(seed);
  const x: number[] = [], y: number[] = [], colour: string[] = [], label: string[] = [], id: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = gaussian(r), b = gaussian(r);
    const c = ['red', 'green', 'blue'][Math.floor(r() * 3)];
    const z = 2 * a - b + (c === 'red' ? 0.8 : 0) + 0.3 * gaussian(r);
    x.push(a); y.push(b); colour.push(c); label.push(z > 0 ? 'yes' : 'no'); id.push(i + 1);
  }
  return { columns: [{ name: 'id', values: id }, { name: 'x', values: x }, { name: 'y', values: y }, { name: 'colour', values: colour }, { name: 'label', values: label }] };
}

/** Regression: target = 3x + 2 + noise. */
export function synthRegression(n = 400, seed = 2): Table {
  const r = mulberry32(seed);
  const x: number[] = [], noise: number[] = [], t: number[] = [];
  for (let i = 0; i < n; i++) { const a = r() * 10; const e = gaussian(r); x.push(a); noise.push(r()); t.push(3 * a + 2 + 0.5 * e); }
  return { columns: [{ name: 'x', values: x }, { name: 'junk', values: noise }, { name: 'target', values: t }] };
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export function fakeHost(opts: { pick?: string[]; save?: string | null } = {}) {
  const db = new DatabaseSync(':memory:');
  const handlers = new Map<string, (p: unknown, ctx: unknown) => unknown>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const dataDir = mkdtempSync(join(tmpdir(), 'module-data-'));
  const host = {
    moduleId: 'aether.module.data',
    dataDir,
    storage: { db, migrate: (ms: Array<{ up: string }>) => ms.forEach((m) => db.exec(m.up)), kv: { get: () => undefined, set: () => undefined, delete: () => undefined } },
    ipc: { handle: (m: string, h: (p: unknown, ctx: unknown) => unknown) => void handlers.set(m, h), emit: (event: string, payload: unknown) => void emitted.push({ event, payload }) },
    events: { on: () => () => undefined },
    log: { info() {}, warn() {}, error() {} },
    dialogs: { openFile: async () => opts.pick ?? [], saveFile: async () => opts.save ?? null, openFolder: async () => null },
  };
  const m = createMainModule();
  m.activate(host as never);
  const call = (method: string, payload?: unknown, profileId = 'p1') => handlers.get(method)!(payload, { windowId: 1, profileId, isPrivate: false }) as Promise<any>;
  return { call, emitted, dataDir, handlers };
}

