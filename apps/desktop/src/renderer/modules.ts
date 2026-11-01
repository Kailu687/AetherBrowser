import type { AetherRendererModule } from '@aether/plugin-api';
import { configurePdfEngine } from '@aether/pdf-viewer';
import { protectionRendererModule } from '@aether/protection-ui';
import { researchRendererModule } from '@aether/research-module/renderer';
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'katex/dist/katex.min.css';

// pdf.js parses PDFs in a worker bundled with the app (no remote code).
configurePdfEngine({ workerSrc: pdfWorkerSrc });

/**
 * Renderer-side feature modules contributing sidebar panels, in rail order.
 */
export const RENDERER_MODULES: AetherRendererModule[] = [researchRendererModule, protectionRendererModule];
