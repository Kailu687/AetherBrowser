import { lazy, Suspense, type ComponentType } from 'react';
import type { WorkbenchAppApi } from '@aether/plugin-api';
import { MODULE_UIS } from '../addon-modules';

export interface AppDef {
  id: string;
  title: string;
  icon: string;
  description: string;
  /** Main-process module that api.invoke talks to. */
  moduleId: string;
  /** Installable Module that provides it; undefined = built in. */
  addon?: string;
  component: ComponentType<{ api: WorkbenchAppApi }>;
}

function lazyApp(load: () => Promise<ComponentType<{ api: WorkbenchAppApi }>>): ComponentType<{ api: WorkbenchAppApi }> {
  const L = lazy(async () => ({ default: await load() }));
  return function App(props: { api: WorkbenchAppApi }) {
    return (
      <Suspense fallback={<div className="wb-loading">Loading…</div>}>
        <L {...props} />
      </Suspense>
    );
  };
}

/** Built in: ships with every install (Core utilities + Studio). */
const BUILT_IN: AppDef[] = [
  { id: 'store', title: 'Module Store', icon: '🧩', description: 'Install modules for research, electronics, development, aerospace, mechanical, civil, bio, data and maths.', moduleId: 'aether.modules', component: lazyApp(async () => (await import('./ModuleStore')).ModuleStore) },
  { id: 'writer', title: 'Writer', icon: '📝', description: 'Documents and research papers with styles, citations, equations and Word/PDF/LaTeX export. Works offline.', moduleId: 'aether.writer', component: lazyApp(async () => (await import('@aether/writer/ui')).WriterApp) },
  { id: 'code', title: 'Code', icon: '⌨️', description: 'Edit and run code in 25+ languages with the compilers installed on this PC.', moduleId: 'aether.ide', component: lazyApp(async () => (await import('@aether/ide/ui')).CodeApp) },
  { id: 'projects', title: 'Projects', icon: '🗂️', description: 'Project Intelligence: requirements, evidence, tasks, decisions and the sources behind them.', moduleId: 'aether.projects', component: lazyApp(async () => (await import('@aether/projects/ui')).ProjectsApp) },
  { id: 'eng', title: 'Engineering', icon: '📐', description: 'Scientific calculator, unit converter, dimensional checker, plotter and developer toolbox.', moduleId: 'research', component: lazyApp(async () => (await import('@aether/eng-tools/ui')).EngineeringApp) },
];

/** Apps contributed by installable Modules; each is wrapped so a crash or slow load never affects the shell. */
const FROM_MODULES: AppDef[] = MODULE_UIS.flatMap((m) =>
  (m.apps ?? []).map((a) => ({
    id: a.id,
    title: a.title,
    icon: a.icon,
    description: a.description ?? '',
    moduleId: m.id,
    addon: a.addon ?? m.id,
    component: a.component as ComponentType<{ api: WorkbenchAppApi }>,
  })),
);

/**
 * Built-in apps shipped in this release. 0.4.0 is the Writer-first launch:
 * Code, Projects and Engineering are finished in source but stay hidden until
 * they have had the same in-app testing.
 */
const RELEASED = new Set(['store', 'writer']);

export const APPS: AppDef[] = [...BUILT_IN.filter((a) => RELEASED.has(a.id)), ...FROM_MODULES];

export const getApp = (id: string) => APPS.find((a) => a.id === id);
