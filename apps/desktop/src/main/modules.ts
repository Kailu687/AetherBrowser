import type { AetherMainModule } from '@aether/plugin-api';
import { createProtectionModule } from '@aether/protection-module';
import { researchMainModule } from '@aether/research-module';
import { createModuleManager } from '@aether/addons';
import { createWriterModule } from '@aether/writer';
import { createIdeModule } from '@aether/ide';
import { createProjectsModule } from '@aether/projects';
import { app } from 'electron';
import { INSTALLABLE } from './addon-modules';
import { createGoogleModule } from '@aether/google-account';

/** Safe mode: `--safe-mode`, or the one-shot request made from Settings → Modules. Installable Modules stay off. */
export const isSafeMode = (): boolean => process.argv.includes('--safe-mode') || process.env.AETHER_SAFE_MODE === '1';

/** Core module manager; its broker answers permission questions for Studio apps and Modules. */
export const addons = createModuleManager({
  appVersion: app.getVersion(),
  catalog: INSTALLABLE.map((l) => l.manifest),
  safeMode: isSafeMode,
  onRestartSafeMode: () => {
    app.relaunch({ args: [...process.argv.slice(1).filter((a) => a !== '--safe-mode'), '--safe-mode'] });
    app.quit();
  },
});

/**
 * Main-process feature modules (Core + Studio, first-party). Order matters for
 * navigation interceptors: earlier modules decide first. Installable Modules
 * load separately with a scoped host (see addon-modules.ts and module-sandbox.ts).
 */
export const MAIN_MODULES: AetherMainModule[] = [
  // Core: privacy (ad/tracker blocking), focus modes and local time tracking.
  createProtectionModule(),
  // Core: module manager and permission broker.
  addons,
  // Core: shared research library, notebook, citations, optional AI (used by Studio Writer and the Research & Writing module).
  researchMainModule,
  // Core: Google account (sign-in with the user's own OAuth client, Drive appData sync).
  createGoogleModule(),
  // Studio
  createWriterModule(),
  createIdeModule({ broker: addons.broker, nodePath: process.execPath, nodeEnv: { ELECTRON_RUN_AS_NODE: '1' } }),
  createProjectsModule(),
];
