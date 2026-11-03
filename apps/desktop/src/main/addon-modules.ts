import type { AetherMainModule, ModuleManifest } from '@aether/plugin-api';
import { manifest as research, createMainModule as researchMain } from '@aether/module-research';
import { manifest as data, createMainModule as dataMain } from '@aether/module-data';

/**
 * Installable Modules bundled with this build. Each comes from
 * packages/module-<name> and stays off until the user installs it in the
 * Module Store (see docs/modules-contract.md).
 */
export const INSTALLABLE: { manifest: ModuleManifest; main: AetherMainModule }[] = [
  { manifest: research, main: researchMain() },
  { manifest: data, main: dataMain() },
];
