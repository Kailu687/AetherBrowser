import type { AetherRendererModule } from '@aether/plugin-api';
import { rendererModule as researchUi } from '@aether/module-research/ui';
import { rendererModule as dataUi } from '@aether/module-data/ui';

/**
 * UI halves of the installable Modules bundled with this build
 * (`rendererModule` from `@aether/module-<name>/ui`). Their apps and panels
 * stay hidden until the Module is installed and enabled for the profile.
 */
export const MODULE_UIS: AetherRendererModule[] = [researchUi, dataUi];
