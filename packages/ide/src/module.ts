import { mkdirSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AetherMainModule, MainHost } from '@aether/plugin-api';
import { createRunner, detectToolchains, type ToolchainInfo } from './runner.js';
import { ProcessManager } from './projects.js';
import { languageById } from './languages.js';

export const IDE_MODULE_ID = 'aether.ide';

export interface ConsentBroker {
  granted(profileId: string, owner: string, perm: 'process.run' | 'process.servers'): boolean;
}

const obj = (p: unknown): Record<string, unknown> => (p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {});
const str = (p: Record<string, unknown>, k: string, max = 2000) => {
  const v = p[k];
  if (typeof v !== 'string' || v.length > max) throw new Error(`Invalid ${k}`);
  return v;
};
const fileName = (n: string) => {
  const b = basename(n);
  if (!/^[\w .()+-]{1,100}\.[\w]{1,8}$/.test(b)) throw new Error('Use a simple file name like main.py');
  return b;
};

/**
 * Studio "Code": scratch files, one-shot runs with installed toolchains and a
 * basic terminal. Running anything needs the user's one-time consent
 * (Studio permission `process.run`; the terminal needs `process.servers`).
 */
export function createIdeModule(opts: { broker: ConsentBroker; nodePath: string; nodeEnv?: NodeJS.ProcessEnv }): AetherMainModule {
  let toolchains: Promise<ToolchainInfo[]> | null = null;
  return {
    id: IDE_MODULE_ID,
    activate(host: MainHost) {
      const scratch = join(host.dataDir, 'scratch');
      const runs = join(host.dataDir, 'runs');
      const preview = join(host.dataDir, 'preview');
      for (const d of [scratch, runs, preview]) mkdirSync(d, { recursive: true });
      const runner = createRunner({ workDir: runs, nodePath: opts.nodePath, nodeEnv: opts.nodeEnv });
      const procs = new ProcessManager((event, payload) => host.ipc.emit(`term.${event}`, payload));
      const need = (profileId: string, perm: 'process.run' | 'process.servers') => {
        if (!opts.broker.granted(profileId, 'studio', perm)) throw new Error(`permission-required:studio:${perm}`);
      };
      const h = (name: string, fn: (p: Record<string, unknown>, ctx: { profileId: string; windowId: number; isPrivate: boolean }) => unknown) => host.ipc.handle(name, (p, ctx) => fn(obj(p), ctx));

      h('toolchains', (p) => {
        if (!toolchains || p.refresh === true) toolchains = detectToolchains();
        return toolchains;
      });
      h('run', (p, ctx) => {
        need(ctx.profileId, 'process.run');
        const lang = str(p, 'lang', 40);
        if (!languageById(lang)) throw new Error('Unknown language');
        const { id, done } = runner.run(
          { lang, code: str(p, 'code', 2_000_000), stdin: typeof p.stdin === 'string' ? p.stdin.slice(0, 1_000_000) : undefined, timeoutMs: Number(p.timeoutMs) || 30_000 },
          (stream, chunk) => host.ipc.emit('run.output', { id, stream, chunk }, ctx.windowId),
        );
        void done.then((r) => host.ipc.emit('run.done', { id, result: r }, ctx.windowId));
        return { id };
      });
      h('run.input', (p) => runner.input(str(p, 'id', 100), str(p, 'text', 100_000)));
      h('run.kill', (p) => runner.kill(str(p, 'id', 100)));

      // Scratch files live in AETHER's data folder.
      h('scratch.list', async () => {
        const names = await readdir(scratch);
        return Promise.all(names.map(async (n) => ({ name: n, modified: (await stat(join(scratch, n))).mtimeMs }))).then((l) => l.sort((a, b) => b.modified - a.modified));
      });
      h('scratch.read', (p) => readFile(join(scratch, fileName(str(p, 'name', 120))), 'utf8'));
      h('scratch.write', async (p) => {
        await writeFile(join(scratch, fileName(str(p, 'name', 120))), str(p, 'text', 5_000_000), 'utf8');
        return true;
      });
      h('scratch.delete', async (p) => {
        await rm(join(scratch, fileName(str(p, 'name', 120))), { force: true });
        return true;
      });
      // Open/save anywhere the user picks in a dialog.
      h('file.open', async () => {
        const [path] = (await host.dialogs?.openFile({ title: 'Open code file' })) ?? [];
        if (!path) return null;
        const s = await stat(path);
        if (s.size > 5_000_000) throw new Error('File is larger than 5 MB');
        return { path, name: basename(path), text: await readFile(path, 'utf8') };
      });
      h('file.saveAs', async (p) => {
        const path = await host.dialogs?.saveFile({ title: 'Save code file', defaultPath: fileName(str(p, 'name', 120)) });
        if (!path) return null;
        await writeFile(path, str(p, 'text', 5_000_000), 'utf8');
        return { path, name: basename(path) };
      });
      h('preview', async (p, ctx) => {
        const file = join(preview, `page-${Date.now()}.html`);
        await writeFile(file, str(p, 'html', 5_000_000), 'utf8');
        host.tabs.open(ctx.windowId, pathToFileURL(file).toString());
        return true;
      });
      // Basic terminal (Studio). Developer Studio Lab adds projects, servers and Git on top.
      h('term.start', (p, ctx) => {
        need(ctx.profileId, 'process.servers');
        const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : scratch;
        return procs.start(cwd, str(p, 'command', 4000));
      });
      h('term.input', (p) => procs.input(str(p, 'id', 100), str(p, 'text', 100_000)));
      h('term.stop', (p) => procs.stop(str(p, 'id', 100)));
      h('term.list', () => procs.list());
      h('term.log', (p) => procs.log(str(p, 'id', 100)));
      host.events.on('appWillQuit', () => procs.stopAll());
    },
  };
}
