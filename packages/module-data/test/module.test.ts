import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateManifest } from '@aether/addons';
import { manifest } from '../src/index.js';
import { synthClassification, fakeHost } from './helpers.js';
import { toCsv } from '../src/csv.js';


describe('manifest', () => {
  it('passes the core validator and keeps permissions narrow', () => {
    expect(validateManifest(manifest as never)).toEqual([]);
    expect(manifest.permissions).toEqual(['storage', 'files.pick']);
    expect(manifest.network).toBe('none');
    expect(JSON.stringify(manifest)).not.toMatch(/\blab\b/i);
  });
});

describe('module IPC end to end', () => {
  it('imports a picked CSV, profiles, cleans, trains, reports, predicts and exports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pick-'));
    const file = join(dir, 'synth.csv');
    writeFileSync(file, toCsv(synthClassification(300)));
    const save = join(dir, 'model.aether-model.json');
    const h = fakeHost({ pick: [file], save });
    const imp = await h.call('datasets.import', {});
    expect(imp.version.rows).toBe(300);
    const vId = imp.version.id;
    const prof = await h.call('version.profile', { versionId: vId });
    expect(prof.columns).toBe(5);
    const page = await h.call('version.rows', { versionId: vId, start: 0, count: 5 });
    expect(page.rows).toHaveLength(5);
    const v2 = await h.call('pipeline.apply', { versionId: vId, steps: [{ op: 'filter', expr: 'x > -10' }] });
    expect(v2.parentId).toBe(vId);
    expect(v2.steps).toHaveLength(1);
    const res = await h.call('ml.train', { versionId: v2.id, config: { target: 'label', features: ['x', 'y', 'colour'], model: 'logistic', split: { strategy: 'stratified', testFraction: 0.25, seed: 1 } } });
    expect(res.result.primary.value).toBeGreaterThan(0.8);
    expect(res.result.artifact).toBeUndefined();
    expect(h.emitted.some((e) => e.event === 'ml.progress' || e.event === 'ml.started')).toBe(true);
    const runs = await h.call('runs.list', {});
    expect(runs).toHaveLength(1);
    const report = await h.call('runs.report', { runId: res.runId });
    expect(report).toContain(v2.sha256);
    expect(report).toContain('Logistic regression');
    const pred = await h.call('model.predict', { runId: res.runId, rows: [{ x: 3, y: -2, colour: 'red' }] });
    expect(pred.predictions[0].prediction).toBe('yes');
    const pv = await h.call('model.predictVersion', { runId: res.runId, versionId: v2.id });
    expect(pv.cols).toBe(6);
    const out = await h.call('model.export', { runId: res.runId });
    expect(out).toBe(save);
    expect(JSON.parse(readFileSync(save, 'utf8')).format).toBe('aether-data-model');
  });

  it('isolates profiles and rejects bad payloads', async () => {
    const h = fakeHost();
    const imp = await h.call('datasets.importText', { text: 'a,b\n1,2\n3,4\n', name: 'tiny' });
    await expect(h.call('version.rows', { versionId: imp.version.id, start: 0, count: 5 }, 'p2')).rejects.toThrow(/not-found/);
    expect(await h.call('datasets.list', {}, 'p2')).toEqual([]);
    await expect(h.call('version.rows', { versionId: '../../etc/passwd' })).rejects.toThrow(/bad-request/);
    await expect(h.call('pipeline.preview', { versionId: imp.version.id, steps: [{ op: 'filter', expr: 'process.exit()' }] })).rejects.toThrow(/Unknown function|Unexpected/);
    await expect(h.call('ml.train', { versionId: imp.version.id, config: { target: 'a', features: ['b'], model: '__proto__' } })).rejects.toThrow(/Unknown model/);
  });

  it('refuses tampered dataset snapshots and hostile model files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'evil-'));
    const evil = join(dir, 'evil.json');
    const h = fakeHost({ pick: [evil] });
    const imp = await h.call('datasets.importText', { text: 'a,b\n1,2\n3,4\n' });
    // A tree whose child points back to the root would loop forever.
    writeFileSync(evil, JSON.stringify({ format: 'aether-data-model', version: 1, target: { name: 'b', task: 'regression' }, inputs: ['a'], preprocessor: { features: [{ name: 'a', kind: 'numeric', median: 0, mean: 0, std: 1, missingIndicator: false }], outputNames: ['a'], scale: true }, model: { type: 'tree', task: 'regression', params: {}, nInputs: 1, nClasses: 0, state: { nodes: [{ f: 0, t: 0, l: 0, r: 0, v: [1] }] } } }));
    await expect(h.call('model.import', { versionId: imp.version.id })).rejects.toThrow(/bad-model.*child/);
  });
});
