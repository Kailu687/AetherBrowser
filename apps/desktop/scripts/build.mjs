// Builds main + preload with esbuild and the UI with Vite into dist/.
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');

export async function buildMain({ dev = false } = {}) {
  const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: dev ? 'inline' : false, minify: !dev, external: ['electron'], logLevel: 'warning' };
  await esbuild({ ...common, entryPoints: [join(root, 'src/main/index.ts')], outfile: join(dist, 'main.cjs') });
  await esbuild({ ...common, entryPoints: [join(root, 'src/preload/ui.ts')], outfile: join(dist, 'preload.cjs') });
  await esbuild({ ...common, platform: 'browser', target: 'chrome140', entryPoints: [join(root, 'src/preload/content.ts')], outfile: join(dist, 'content.cjs') });
  cpSync(join(root, 'resources'), dist, { recursive: true });
  cpSync(createRequire(import.meta.url).resolve('@mozilla/readability/Readability.js'), join(dist, 'readability.js'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!watch) rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  await buildMain();
  await viteBuild({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn' });
  console.log('Built to', dist);
}
