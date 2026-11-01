import type { AetherRendererModule } from '@aether/plugin-api';
import { FocusPanel } from './FocusPanel';
import { PrivacyPanel } from './PrivacyPanel';
import { TimePanel } from './TimePanel';

/** Sidebar panels for the "aether.protection" main-process module. */
export const protectionRendererModule: AetherRendererModule = {
  id: 'aether.protection',
  panels: [
    { id: 'focus', title: 'Focus', icon: '◎', component: FocusPanel, width: 340 },
    { id: 'privacy', title: 'Privacy', icon: '⛨', component: PrivacyPanel, width: 340 },
    { id: 'time', title: 'Time', icon: '◷', component: TimePanel, width: 340 },
  ],
};

export { FocusPanel, PrivacyPanel, TimePanel };
