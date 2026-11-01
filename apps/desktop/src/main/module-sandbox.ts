import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import type { ModuleManifest, ModulePermission, MainHost, ModuleMigration, ModuleStorage, ProcessResult, ProcessService, SqlDatabase } from '@aether/plugin-api';
import { which } from '@aether/ide';

const MAX_OUT = 2_000_000;
const SAFE_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'LANG', 'LC_ALL', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'ComSpec'];

/** Environment for Module processes: no tokens or secrets inherited from AETHER's own environment. */
export function scrubbedEnv(src: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of SAFE_ENV) if (src[k] !== undefined) out[k] = src[k];
  out.PYTHONUNBUFFERED = '1';
  return out;
}

export function hostAllowed(perms: ModulePermission[], rawUrl: string): 'yes' | 'no' | 'ask' {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'no';
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (loopback && (u.protocol === 'http:' || u.protocol === 'https:')) return perms.includes('net:localhost') ? 'yes' : perms.includes('net:user') ? 'ask' : 'no';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && perms.includes('net:user'))) return 'no';
  for (const p of perms) {
    if (!p.startsWith('net:') || p === 'net:localhost' || p === 'net:user') continue;
    const h = p.slice(4).toLowerCase();
    const host = u.hostname.toLowerCase();
    if (h.startsWith('*.') ? host === h.slice(2) || host.endsWith(h.slice(1)) : host === h) return 'yes';
  }
  return perms.includes('net:user') ? 'ask' : 'no';
}

export function inside(root: string, p: string): boolean {
  const r = resolve(root);
  const x = resolve(p);
  return x === r || x.startsWith(r + sep);
}

/** A Module's own SQLite file with the same ModuleStorage shape as core modules. */
async function moduleStorage(dataDir: string, kv: ModuleStorage['kv']): Promise<ModuleStorage> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dataDir, 'module.sqlite')) as unknown as SqlDatabase;
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  return {
    db,
    kv,
    migrate(migrations: ModuleMigration[]) {
      const done = new Set((db.prepare('SELECT version FROM _migrations').all() as { version: number }[]).map((r) => r.version));
      for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
        if (done.has(m.version)) continue;
        db.exec('BEGIN');
        try {
          db.exec(m.up);
          db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)').run(m.version, Date.now());
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      }
    },
  };
}

const parent = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

async function confirm(opts: { title: string; detail: string; risk: 'low' | 'medium' | 'high'; confirmLabel?: string }): Promise<boolean> {
  const { response } = await dialog.showMessageBox(parent(), {
    type: opts.risk === 'high' ? 'warning' : 'question',
    buttons: [opts.confirmLabel ?? 'Allow', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'AETHER',
    message: opts.title,
    detail: opts.detail,
    noLink: true,
  });
  return response === 0;
}

/**
 * Process broker for one Module: resolves programs on PATH, asks the user once
 * per program, never uses a shell for run(), scrubs the environment, confines
 * cwd to the Module's folder or folders the user picked, caps output and kills
 * on timeout.
 */
export function createProcessService(lab: ModuleManifest, opts: { dataDir: string; folders: Set<string>; kv: ModuleStorage['kv']; allowServers: boolean }): ProcessService {
  const approved = () => new Set(opts.kv.get<string[]>('approved-programs') ?? []);
  const cwdOk = (cwd?: string) => {
    const c = cwd ?? opts.dataDir;
    if (inside(opts.dataDir, c) || [...opts.folders].some((f) => inside(f, c))) return c;
    throw new Error('Working folder must be the module’s own folder or one you picked');
  };
  const ensure = async (program: string): Promise<string> => {
    const path = await which(program);
    if (!path) throw new Error(`${program} is not installed or not on PATH`);
    let real = path;
    try {
      real = realpathSync(path);
    } catch {
      /* keep path */
    }
    if (!approved().has(real)) {
      const ok = await confirm({ title: `Allow ${lab.name} to run ${program}?`, detail: `${real}\n\nIt runs with your Windows account's rights, without a shell, and is stopped if it runs too long. You can revoke this in Module Store → ${lab.name} → Permissions.`, risk: 'high' });
      if (!ok) throw new Error(`You did not allow ${program}`);
      opts.kv.set('approved-programs', [...approved(), real]);
    }
    return real;
  };
  type Listener = Parameters<NonNullable<ProcessService['on']>>[1];
  const listeners = new Map<string, Set<Listener>>();
  const emit = (ev: string, p: Parameters<Listener>[0]) => listeners.get(ev)?.forEach((l) => l(p));
  const live = new Map<string, ChildProcess>();

  const svc: ProcessService = {
    async which(program) {
      const p = await which(program);
      return p ? { path: p } : null;
    },
    async run(program, args, o = {}) {
      const exe = await ensure(program);
      const cwd = cwdOk(o.cwd);
      const timeoutMs = Math.min(Math.max(o.timeoutMs ?? 60_000, 500), 600_000);
      return new Promise<ProcessResult>((res) => {
        const start = Date.now();
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const child = spawn(exe, args.map(String), { cwd, env: scrubbedEnv(), shell: false, windowsHide: true });
        const t = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);
        child.stdout?.on('data', (d) => stdout.length < MAX_OUT && (stdout += d));
        child.stderr?.on('data', (d) => stderr.length < MAX_OUT && (stderr += d));
        child.on('error', (e) => (stderr += e.message));
        child.on('close', (code) => {
          clearTimeout(t);
          res({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - start });
        });
        if (o.stdin !== undefined) child.stdin?.end(o.stdin);
      });
    },
  };
  if (opts.allowServers) {
    svc.start = async (command, o) => {
      const cwd = cwdOk(o.cwd);
      const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      let child: ChildProcess;
      if (o.shell === false) {
        const [prog, ...args] = command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [];
        child = spawn(await ensure(prog), args, { cwd, env: scrubbedEnv(), shell: false, windowsHide: true });
      } else {
        // Terminal commands: the user typed them; the module was approved for process.servers at install.
        const sh = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
        child = spawn(sh, process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command], { cwd, env: scrubbedEnv(), windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
      }
      live.set(id, child);
      const out = (stream: 'stdout' | 'stderr') => (d: Buffer) => {
        const chunk = d.toString('utf8');
        emit('output', { id, stream, chunk });
        for (const m of chunk.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/g)) emit('port', { id, port: Number(m[1]) });
      };
      child.stdout?.on('data', out('stdout'));
      child.stderr?.on('data', out('stderr'));
      child.on('error', (e) => emit('output', { id, stream: 'stderr', chunk: e.message + '\n' }));
      child.on('close', (code) => {
        live.delete(id);
        emit('exit', { id, code });
      });
      return { id };
    };
    svc.input = (id, text) => {
      const c = live.get(id);
      if (!c?.stdin || c.stdin.destroyed) return false;
      c.stdin.write(text);
      return true;
    };
    svc.stop = (id) => {
      const c = live.get(id);
      if (!c) return false;
      if (process.platform === 'win32' && c.pid) spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { windowsHide: true });
      else c.kill();
      return true;
    };
    svc.on = (event, l) => {
      const set = listeners.get(event) ?? new Set();
      set.add(l);
      listeners.set(event, set);
      return () => set.delete(l);
    };
  }
  return svc;
}

/** Builds the restricted MainHost a Module receives from the full core host and its approved permissions. */
export async function scopedModuleHost(full: MainHost, lab: ModuleManifest): Promise<MainHost> {
  const perms = lab.permissions;
  const has = (p: ModulePermission) => perms.includes(p);
  mkdirSync(full.dataDir, { recursive: true });
  const storage = await moduleStorage(full.dataDir, full.storage.kv);
  const folders = new Set<string>(full.storage.kv.get<string[]>('approved-folders') ?? []);
  const noop = () => () => undefined;
  const deny = (what: string) => () => {
    throw new Error(`${lab.name} has no permission to ${what}`);
  };
  const tabEvents = new Set(['activeTabChanged', 'tabNavigated', 'tabAudible', 'tabLoadFailed']);
  const userHosts = () => new Set(full.storage.kv.get<string[]>('approved-hosts') ?? []);

  const host: MainHost = {
    moduleId: lab.id,
    dataDir: full.dataDir,
    storage,
    sessions: { onSessionCreated: noop },
    navigation: { addInterceptor: noop },
    internalPages: { register: () => full.log.warn('Modules cannot register aether:// pages') },
    events: { on: (name, l) => (tabEvents.has(name) && !has('tabs.read') ? () => undefined : full.events.on(name, l)) },
    tabs: {
      getActive: has('tabs.read') ? full.tabs.getActive : () => null,
      get: has('tabs.read') ? full.tabs.get : () => null,
      list: has('tabs.read') ? full.tabs.list : () => [],
      open: full.tabs.open,
      navigate: deny('navigate tabs'),
      fromWebContentsId: () => null,
      getPageContent: has('tabs.read') ? full.tabs.getPageContent : (deny('read pages') as never),
      savePage: has('tabs.read') ? full.tabs.savePage : undefined,
    },
    profiles: { list: () => [], get: () => null },
    ipc: full.ipc,
    system: full.system,
    net: {
      fetch: async (url, init) => {
        const check = async (u: string) => {
          const verdict = hostAllowed(perms, u);
          if (verdict === 'no') throw new Error(`${lab.name} may not connect to ${new URL(u).host} (not in its manifest)`);
          if (verdict === 'ask') {
            const h = new URL(u).host;
            if (!userHosts().has(h)) {
              if (!(await confirm({ title: `Let ${lab.name} connect to ${h}?`, detail: 'You typed this address. AETHER asks once per address. Cookies from your browsing are never sent.', risk: 'medium' })))
                throw new Error(`You did not allow ${h}`);
              full.storage.kv.set('approved-hosts', [...userHosts(), h]);
            }
          }
        };
        // Follow redirects ourselves so every hop is checked against the manifest.
        let current = String(url);
        let req: RequestInit = { ...init, credentials: 'omit', redirect: 'manual' } as RequestInit;
        for (let hop = 0; hop <= 5; hop++) {
          await check(current);
          const res = await full.net.fetch(current, req);
          const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
          if (!loc) return res;
          current = new URL(loc, current).toString();
          // 303 (and 301/302 after POST) switch to GET without a body, like browsers do.
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && req.method && req.method.toUpperCase() !== 'GET')) req = { ...req, method: 'GET', body: undefined };
        }
        throw new Error(`${lab.name}: too many redirects`);
      },
    },
    secrets: has('secrets') ? full.secrets : undefined,
    content: { onFrameStart: noop },
    notifications: full.notifications,
    log: full.log,
    dialogs:
      has('files.pick') || has('files.folder')
        ? {
            openFile: has('files.pick') ? full.dialogs!.openFile : async () => [],
            saveFile: has('files.pick') ? full.dialogs!.saveFile : async () => null,
            openFolder: has('files.folder')
              ? async (o) => {
                  const f = await full.dialogs!.openFolder(o);
                  if (f) {
                    folders.add(resolve(f));
                    full.storage.kv.set('approved-folders', [...folders]);
                  }
                  return f;
                }
              : async () => null,
          }
        : undefined,
    openExternal: full.openExternal,
    printToPdf: full.printToPdf,
    approvals: { confirm },
    processes: has('process.run') || has('process.servers') ? createProcessService(lab, { dataDir: full.dataDir, folders, kv: full.storage.kv, allowServers: has('process.servers') }) : undefined,
    ai: has('ai.optional') ? full.ai : undefined,
  };
  return host;
}
