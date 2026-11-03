// @vitest-environment jsdom
import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { WorkbenchAppApi } from '@aether/plugin-api';
import { rendererModule } from '../src/ui/index.js';
import { DatasetsApp } from '../src/ui/DatasetsApp.js';
import { TrainerApp } from '../src/ui/TrainerApp.js';
import { ExperimentsApp } from '../src/ui/ExperimentsApp.js';
import { fakeHost, synthClassification } from './helpers.js';
import { toCsv } from '../src/csv.js';

afterEach(cleanup);

function apiFor(h: ReturnType<typeof fakeHost>, arg?: string): WorkbenchAppApi & { opened: string[] } {
  const opened: string[] = [];
  return {
    invoke: (m: string, p?: unknown) => h.call(m, p ?? {}),
    on: () => () => undefined,
    openUrl: () => undefined,
    activeTab: { tabId: null, url: '', title: '', profileId: 'p1', workspaceId: null, isPrivate: false },
    invokeModule: async () => ({ id: 'doc1' }) as never,
    download: () => undefined,
    openApp: (id: string, a?: string) => void opened.push(`${id}:${a ?? ''}`),
    arg,
    opened,
  } as never;
}

describe('renderer module', () => {
  it('declares three lazy apps tied to the module id', () => {
    expect(rendererModule.id).toBe('aether.module.data');
    expect(rendererModule.apps!.map((a) => a.id)).toEqual(['data.datasets', 'data.trainer', 'data.experiments']);
    expect(rendererModule.apps!.every((a) => a.addon === 'aether.module.data')).toBe(true);
  });
});

describe('apps against the real main module', () => {
  it('Datasets: shows an imported dataset, its profile and a cleaning preview', async () => {
    const h = fakeHost();
    await h.call('datasets.importText', { name: 'Sensors', text: toCsv(synthClassification(120)) });
    render(<DatasetsApp api={apiFor(h)} />);
    expect(await screen.findByRole('heading', { name: 'Sensors' })).toBeTruthy();
    await screen.findByText(/120 rows × 5 columns/);
    fireEvent.click(screen.getByRole('tab', { name: 'Profile' }));
    await screen.findByText('duplicate rows');
    fireEvent.click(screen.getByRole('tab', { name: 'Clean' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    await waitFor(() => expect(screen.getByText(/Preview \(first 200 rows\)/)).toBeTruthy(), { timeout: 3000 });
  });

  it('Trainer: trains a model end to end and shows results', async () => {
    const h = fakeHost();
    const imp = await h.call('datasets.importText', { name: 'Synth', text: toCsv(synthClassification(200)) });
    const api = apiFor(h, imp.version.id);
    render(<TrainerApp api={api} />);
    const train = await screen.findByRole('button', { name: 'Train' });
    await waitFor(() => expect((train as HTMLButtonElement).disabled).toBe(false));
    await screen.findByText('Random forest', { selector: 'option' });
    fireEvent.click(train);
    expect(await screen.findByRole('heading', { name: 'Results' }, { timeout: 8000 })).toBeTruthy();
    expect(screen.getByText('Confusion matrix')).toBeTruthy();
    expect((await h.call('runs.list', {})).length).toBe(1);
  });

  it('Experiments: lists runs, shows a report and predicts', async () => {
    const h = fakeHost();
    const imp = await h.call('datasets.importText', { name: 'Synth', text: toCsv(synthClassification(200)) });
    await h.call('ml.train', { versionId: imp.version.id, name: 'My run', config: { target: 'label', features: ['x', 'y', 'colour'], model: 'tree', split: { strategy: 'stratified', testFraction: 0.25, seed: 1 } } });
    const api = apiFor(h);
    render(<ExperimentsApp api={api} />);
    expect(await screen.findByRole('heading', { name: 'My run' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    await screen.findByText(/Every number below was computed in this run/);
    fireEvent.click(screen.getByRole('button', { name: 'Open report in Writer' }));
    await waitFor(() => expect(api.opened).toContain('writer:doc1'));
  });
});
