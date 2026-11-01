import type { AetherMainModule, ModuleManifest } from '@aether/plugin-api';

/**
 * Installable Modules bundled with this build. Each comes from
 * packages/module-<name> and stays off until the user installs it in the
 * Module Store (see docs/modules-contract.md).
 */
export const INSTALLABLE: { manifest: ModuleManifest; main: AetherMainModule }[] = [];
