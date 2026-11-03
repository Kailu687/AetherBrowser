import type { AetherRendererModule } from '@aether/plugin-api';
import { lazyApp } from './common.js';
import './data.css';

const ID = 'aether.module.data';

export const rendererModule: AetherRendererModule = {
  id: ID,
  apps: [
    { id: 'data.datasets', title: 'Datasets', icon: '🗂️', description: 'Import, profile, clean, chart and compare datasets.', addon: ID, component: lazyApp(async () => (await import('./DatasetsApp.js')).DatasetsApp) },
    { id: 'data.trainer', title: 'ML Trainer', icon: '🧠', description: 'Train and evaluate models with leakage checks and cross-validation.', addon: ID, component: lazyApp(async () => (await import('./TrainerApp.js')).TrainerApp) },
    { id: 'data.experiments', title: 'Experiments', icon: '🧪', description: 'Compare runs, write reports, export models and run predictions.', addon: ID, component: lazyApp(async () => (await import('./ExperimentsApp.js')).ExperimentsApp) },
  ],
};
