// Dev loop: Vite dev server for the UI + esbuild for main, then launches Electron.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { buildMain } from './build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ configFile: join(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls.local[0];
await buildMain({ dev: true });
const electron = createRequire(import.meta.url)('electron');
const child = spawn(electron, ['.'], { cwd: root, stdio: 'inherit', env: { ...process.env, AETHER_DEV_URL: url } });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
