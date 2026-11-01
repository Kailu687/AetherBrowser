import type { AetherMainModule } from '@aether/plugin-api';
import { createProtectionModule } from '@aether/protection-module';
import { researchMainModule } from '@aether/research-module';

/**
 * Main-process feature modules. Sibling packages (privacy, focus, activity,
 * research, writing) add themselves here. Order matters for navigation
 * interceptors: earlier modules decide first.
 */
export const MAIN_MODULES: AetherMainModule[] = [
  // Privacy (ad/tracker blocking), focus modes and local time tracking.
  createProtectionModule(),
  // Research: notebook, sources and citations, paper writer, calculators, optional AI.
  researchMainModule,
];
