import type { AetherRendererModule } from '@aether/plugin-api';

/**
 * UI halves of the installable Modules bundled with this build
 * (`rendererModule` from `@aether/module-<name>/ui`). Their apps and panels
 * stay hidden until the Module is installed and enabled for the profile.
 */
export const MODULE_UIS: AetherRendererModule[] = [];
