import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { access, constants } from 'node:fs/promises';
import { languageById, substitute, suggestedFileName, type LanguageDef, type RunStep } from './languages.js';

const EXE = process.platform === 'win32' ? '.exe' : '';
const MAX_OUTPUT = 2_000_000;

/** Finds an executable on PATH (plus common Windows install folders), without running a shell. */
export async function which(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (/[\\/]/.test(name)) {
    try {
      await access(name, constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const local = env.LOCALAPPDATA ?? '';
    dirs.push(join(pf, 'nodejs'), join(pf, 'Git', 'bin'), join(pf, 'Go', 'bin'), 'C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin', join(local, 'Programs', 'Python', 'Launcher'), join(env.USERPROFILE ?? '', '.cargo', 'bin'));
  }
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  for (const d of dirs) {
    for (const e of name.includes('.') ? [''] : exts) {
      const p = join(d, name + e);
      try {
        await access(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return p;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

export interface ToolchainInfo {
  lang: string;
  available: boolean;
  path?: string;
  version?: string;
}

async function firstTool(step: RunStep): Promise<string | null> {
  for (const t of step.tool) {
    if (t.includes('{out}')) return t;
    const p = await which(t);
    if (p) return p;
  }
  return null;
}

function quickVersion(path: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const p = spawn(path, args, { windowsHide: true, timeout: 4000 });
      let out = '';
      p.stdout?.on('data', (d) => (out += d));
      p.stderr?.on('data', (d) => (out += d));
      p.on('error', () => resolve(undefined));
      p.on('close', () => resolve(out.split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 120)));
    } catch {
      resolve(undefined);
    }
  });
}

/** Which languages can run on this machine. Cached by the caller. */
export async function detectToolchains(): Promise<ToolchainInfo[]> {
  const { LANGUAGES } = await import('./languages.js');
  return Promise.all(
    LANGUAGES.map(async (l): Promise<ToolchainInfo> => {
      if (l.run === 'node' || l.run === 'ts' || l.run === 'sqlite' || l.run === 'preview') return { lang: l.id, available: true, version: l.run === 'sqlite' ? 'built in (SQLite)' : l.run === 'preview' ? 'opens in a tab' : `built in (Node ${process.versions.node})` };
      if (l.run === 'none') return { lang: l.id, available: false };
      const step = l.compile ?? l.exec!;
      const path = await firstTool(step);
      if (!path) return { lang: l.id, available: false };
      const vflag = /java$|java\.exe$/i.test(path) ? ['-version'] : /go(\.exe)?$/i.test(path) ? ['version'] : ['--version'];
      return { lang: l.id, available: true, path, version: await quickVersion(path, vflag) };
    }),
  );
}

export interface RunRequest {
  lang: string;
  code: string;
  stdin?: string;
  timeoutMs?: number;
  /** Extra args passed to the program. */
  args?: string[];
}

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  phase: 'compile' | 'run';
  timedOut?: boolean;
  missing?: { tool: string[]; install?: string };
  table?: { columns: string[]; rows: unknown[][] }[];
}

export interface Runner {
  run(req: RunRequest, onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void): { id: string; done: Promise<RunResult> };
  input(id: string, text: string): boolean;
  kill(id: string): boolean;
}

/**
 * Runs snippets in a throwaway folder. JavaScript/TypeScript use the Node
 * runtime bundled with AETHER (Electron in Node mode); other languages use the
 * compilers and interpreters installed on the PC. Each run has a time limit.
 */
export function createRunner(opts: { workDir: string; nodePath: string; nodeEnv?: NodeJS.ProcessEnv }): Runner {
  const live = new Map<string, ChildProcess>();

  const exec = (cmd: string, args: string[], cwd: string, input: string | undefined, timeoutMs: number, env: NodeJS.ProcessEnv, phase: 'compile' | 'run', onOutput: ((s: 'stdout' | 'stderr', c: string) => void) | undefined, id: string) =>
    new Promise<RunResult>((resolve) => {
      const start = Date.now();
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let child: ChildProcess;
      try {
        child = spawn(cmd, args, { cwd, env, windowsHide: true, shell: /\.(cmd|bat)$/i.test(cmd) });
      } catch (e) {
        return resolve({ ok: false, exitCode: null, stdout, stderr: String(e), durationMs: 0, phase });
      }
      live.set(id, child);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        if (stdout.length < MAX_OUTPUT) stdout += d;
        onOutput?.('stdout', d);
      });
      child.stderr?.on('data', (d: string) => {
        if (stderr.length < MAX_OUTPUT) stderr += d;
        onOutput?.('stderr', d);
      });
      child.on('error', (e) => {
        stderr += String(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        live.delete(id);
        resolve({ ok: code === 0 && !timedOut, exitCode: code, stdout, stderr: timedOut ? `${stderr}\n[stopped after ${Math.round(timeoutMs / 1000)} s]` : stderr, durationMs: Date.now() - start, phase, timedOut });
      });
      if (input) child.stdin?.write(input);
      if (input !== undefined) child.stdin?.end();
    });

  return {
    run(req, onOutput) {
      const id = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const done = (async (): Promise<RunResult> => {
        const lang = languageById(req.lang);
        if (!lang) return { ok: false, exitCode: null, stdout: '', stderr: `Unknown language ${req.lang}`, durationMs: 0, phase: 'run' };
        const dir = join(opts.workDir, id);
        mkdirSync(dir, { recursive: true });
        const timeoutMs = Math.min(Math.max(req.timeoutMs ?? 20_000, 1000), 600_000);
        const stdin = req.stdin === undefined || req.stdin === '' ? undefined : req.stdin.endsWith('\n') ? req.stdin : req.stdin + '\n';
        try {
          if (lang.run === 'sqlite') return runSql(req.code);
          let code = req.code;
          if (lang.run === 'ts') {
            const { transform } = await import('sucrase');
            try {
              code = transform(code, { transforms: ['typescript', 'imports'], filePath: 'main.ts' }).code;
            } catch (e) {
              return { ok: false, exitCode: null, stdout: '', stderr: `TypeScript error: ${(e as Error).message}`, durationMs: 0, phase: 'compile' };
            }
          }
          const fileName = lang.run === 'ts' ? 'main.cjs' : suggestedFileName(lang, code);
          const file = join(dir, fileName);
          writeFileSync(file, code, 'utf8');
          const vars = { file, dir, out: join(dir, 'prog'), base: fileName.replace(/\.[^.]+$/, ''), exe: EXE };
          const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
          if (lang.run === 'node' || lang.run === 'ts') return await exec(opts.nodePath, [file, ...(req.args ?? [])], dir, stdin, timeoutMs, { ...env, ...opts.nodeEnv }, 'run', onOutput, id);
          if (lang.compile) {
            const cc = await firstTool(lang.compile);
            if (!cc) return { ok: false, exitCode: null, stdout: '', stderr: '', durationMs: 0, phase: 'compile', missing: { tool: lang.compile.tool, install: lang.install } };
            const r = await exec(cc, substitute(lang.compile.args, vars), dir, undefined, Math.max(timeoutMs, 60_000), env, 'compile', onOutput, id);
            if (!r.ok) return r;
          }
          const step = lang.exec!;
          const tool = await firstTool(step);
          if (!tool) return { ok: false, exitCode: null, stdout: '', stderr: '', durationMs: 0, phase: 'run', missing: { tool: step.tool, install: lang.install } };
          const cmd = substitute([tool], vars)[0];
          const args = [...substitute(step.args, vars), ...(req.args ?? [])];
          // The Windows "py" launcher needs -3 to pick Python 3.
          if (/[\\/]py(\.exe)?$/i.test(cmd)) args.unshift('-3');
          return await exec(cmd, args, dir, stdin, timeoutMs, env, 'run', onOutput, id);
        } finally {
          setTimeout(() => rmSync(dir, { recursive: true, force: true }), 2000);
        }
      })();
      return { id, done };
    },
    input(id, text) {
      const c = live.get(id);
      if (!c?.stdin || c.stdin.destroyed) return false;
      c.stdin.write(text.endsWith('\n') ? text : text + '\n');
      return true;
    },
    kill(id) {
      const c = live.get(id);
      if (!c) return false;
      c.kill();
      return true;
    },
  };
}

/** Runs SQL against a fresh in-memory SQLite database and returns each SELECT's rows. */
export async function runSql(sql: string): Promise<RunResult> {
  const start = Date.now();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const tables: { columns: string[]; rows: unknown[][] }[] = [];
  let stdout = '';
  try {
    for (const stmtText of splitSql(sql)) {
      const st = db.prepare(stmtText);
      if (/^\s*(select|with|pragma|values)\b/i.test(stmtText) || /\breturning\b/i.test(stmtText)) {
        const rows = st.all() as Record<string, unknown>[];
        const columns = rows.length ? Object.keys(rows[0]) : st.columns().map((c) => c.name);
        tables.push({ columns, rows: rows.map((r) => columns.map((c) => r[c])) });
        stdout += `${rows.length} row${rows.length === 1 ? '' : 's'}\n`;
      } else {
        const r = st.run();
        stdout += `OK (${r.changes} change${Number(r.changes) === 1 ? '' : 's'})\n`;
      }
    }
    return { ok: true, exitCode: 0, stdout, stderr: '', durationMs: Date.now() - start, phase: 'run', table: tables };
  } catch (e) {
    return { ok: false, exitCode: 1, stdout, stderr: (e as Error).message, durationMs: Date.now() - start, phase: 'run', table: tables };
  } finally {
    db.close();
  }
}

export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
    } else if (c === "'" || c === '"') {
      q = c;
      cur += c;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export type { LanguageDef };
