import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Resolves a path inside a project root; refuses anything that escapes it. */
export function safeJoin(root: string, rel: string): string {
  const base = resolve(root);
  const p = resolve(base, rel || '.');
  if (p !== base && !p.startsWith(base + sep)) throw new Error('Path is outside the project folder');
  return p;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '__pycache__', '.venv', 'venv', '.next', '.idea', '.vs', 'bin', 'obj']);

export interface FileEntry {
  path: string;
  name: string;
  dir: boolean;
  size?: number;
}

export async function listDir(root: string, rel = ''): Promise<FileEntry[]> {
  const dir = safeJoin(root, rel);
  const entries = await readdir(dir, { withFileTypes: true });
  const out: FileEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.env' && e.name !== '.gitignore') continue;
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push({ path: p, name: e.name, dir: true });
    else if (e.isFile()) out.push({ path: p, name: e.name, dir: false, size: (await stat(join(dir, e.name)).catch(() => null))?.size });
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export async function readText(root: string, rel: string): Promise<string> {
  const p = safeJoin(root, rel);
  const s = await stat(p);
  if (s.size > 5_000_000) throw new Error('File is larger than 5 MB');
  return readFile(p, 'utf8');
}

export async function writeText(root: string, rel: string, text: string): Promise<void> {
  const p = safeJoin(root, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, text, 'utf8');
}

export async function makeDir(root: string, rel: string) {
  await mkdir(safeJoin(root, rel), { recursive: true });
}

export async function movePath(root: string, from: string, to: string) {
  await rename(safeJoin(root, from), safeJoin(root, to));
}

export async function removePath(root: string, rel: string) {
  if (!rel) throw new Error('Refusing to delete the project root');
  await rm(safeJoin(root, rel), { recursive: true, force: true });
}

/** Plain-text search across the project (skips dependencies and build output). */
export async function searchProject(root: string, query: string, limit = 300): Promise<{ path: string; line: number; text: string }[]> {
  const out: { path: string; line: number; text: string }[] = [];
  const q = query.toLowerCase();
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (out.length >= limit || depth > 12) return;
    for (const e of await listDir(root, rel).catch(() => [])) {
      if (out.length >= limit) return;
      if (e.dir) {
        if (!SKIP.has(e.name)) await walk(e.path, depth + 1);
      } else if ((e.size ?? 0) < 1_000_000 && !/\.(png|jpe?g|gif|ico|pdf|zip|exe|dll|so|o|class|jar|woff2?|ttf|mp[34]|lock)$/i.test(e.name)) {
        const text = await readText(root, e.path).catch(() => '');
        text.split(/\r?\n/).forEach((l, i) => {
          if (out.length < limit && l.toLowerCase().includes(q)) out.push({ path: e.path, line: i + 1, text: l.trim().slice(0, 200) });
        });
      }
    }
  };
  await walk('', 0);
  return out;
}

// ---------------------------------------------------------------------------- processes

export interface ProcInfo {
  id: string;
  name: string;
  command: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
  ports: number[];
}

/** Long-running commands (dev servers, watchers, builds) started from the terminal. */
export class ProcessManager {
  private procs = new Map<string, { info: ProcInfo; child: ChildProcess; log: string }>();
  constructor(private onEvent: (event: 'output' | 'exit' | 'port', payload: unknown) => void) {}

  start(cwd: string, command: string, name?: string): ProcInfo {
    const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const shell = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    const child = spawn(shell, args, { cwd, env: { ...process.env, FORCE_COLOR: '0', PYTHONUNBUFFERED: '1' }, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
    const info: ProcInfo = { id, name: name || command.split(/\s+/).slice(0, 3).join(' '), command, cwd, running: true, exitCode: null, startedAt: Date.now(), ports: [] };
    const entry = { info, child, log: '' };
    this.procs.set(id, entry);
    const onData = (stream: 'stdout' | 'stderr') => (d: Buffer) => {
      const chunk = d.toString('utf8');
      entry.log = (entry.log + chunk).slice(-400_000);
      this.onEvent('output', { id, stream, chunk });
      for (const m of chunk.matchAll(/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})/g)) {
        const port = Number(m[1]);
        if (!info.ports.includes(port)) {
          info.ports.push(port);
          this.onEvent('port', { id, port });
        }
      }
    };
    child.stdout?.on('data', onData('stdout'));
    child.stderr?.on('data', onData('stderr'));
    child.on('error', (e) => this.onEvent('output', { id, stream: 'stderr', chunk: `${e.message}\n` }));
    child.on('close', (code) => {
      info.running = false;
      info.exitCode = code;
      this.onEvent('exit', { id, code });
    });
    return info;
  }

  input(id: string, text: string): boolean {
    const p = this.procs.get(id);
    if (!p?.info.running || !p.child.stdin) return false;
    p.child.stdin.write(text.endsWith('\n') ? text : text + '\n');
    return true;
  }

  stop(id: string): boolean {
    const p = this.procs.get(id);
    if (!p?.info.running) return false;
    if (process.platform === 'win32' && p.child.pid) spawn('taskkill', ['/pid', String(p.child.pid), '/T', '/F'], { windowsHide: true });
    else p.child.kill('SIGTERM');
    return true;
  }

  list(): ProcInfo[] {
    return [...this.procs.values()].map((p) => p.info).sort((a, b) => b.startedAt - a.startedAt);
  }

  log(id: string): string {
    return this.procs.get(id)?.log ?? '';
  }

  forget(id: string) {
    const p = this.procs.get(id);
    if (p && !p.info.running) this.procs.delete(id);
  }

  stopAll() {
    for (const id of this.procs.keys()) this.stop(id);
  }
}

// ---------------------------------------------------------------------------- git

export function git(cwd: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolveP) => {
    let out = '';
    let err = '';
    let child: ChildProcess;
    try {
      child = spawn('git', args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    } catch (e) {
      return resolveP({ ok: false, out: '', err: String(e) });
    }
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (d) => (out += d));
    child.stderr?.on('data', (d) => (err += d));
    child.on('error', (e) => resolveP({ ok: false, out, err: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'Git is not installed (https://git-scm.com/download/win).' : e.message }));
    child.on('close', (code) => {
      clearTimeout(t);
      resolveP({ ok: code === 0, out, err });
    });
  });
}

export function parseGitStatus(porcelain: string): { branch: string; ahead: number; behind: number; files: { path: string; index: string; work: string }[] } {
  const lines = porcelain.split(/\r?\n/).filter(Boolean);
  let branch = '';
  let ahead = 0;
  let behind = 0;
  const files: { path: string; index: string; work: string }[] = [];
  for (const l of lines) {
    if (l.startsWith('## ')) {
      const m = l.slice(3).match(/^([^.\s]+)(?:\.\.\.\S+)?(?: \[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\])?/);
      branch = m?.[1] ?? l.slice(3);
      ahead = Number(m?.[2] ?? 0);
      behind = Number(m?.[3] ?? 0);
    } else files.push({ index: l[0], work: l[1], path: l.slice(3) });
  }
  return { branch, ahead, behind, files };
}

// ---------------------------------------------------------------------------- templates

export const PROJECT_TEMPLATES: { id: string; name: string; description: string; run: string; files: Record<string, string> }[] = [
  {
    id: 'express',
    name: 'Node + Express API',
    description: 'REST API on port 3000 (needs Node.js and npm).',
    run: 'npm install && npm start',
    files: {
      'package.json': JSON.stringify({ name: 'api', version: '1.0.0', type: 'module', scripts: { start: 'node server.js' }, dependencies: { express: '^4.21.0' } }, null, 2) + '\n',
      'server.js': "import express from 'express';\n\nconst app = express();\napp.use(express.json());\n\nconst parts = [{ id: 1, name: 'LM317', qty: 10 }];\n\napp.get('/api/parts', (req, res) => res.json(parts));\napp.post('/api/parts', (req, res) => {\n  const part = { id: parts.length + 1, ...req.body };\n  parts.push(part);\n  res.status(201).json(part);\n});\n\napp.listen(3000, () => console.log('API on http://localhost:3000/api/parts'));\n",
      'README.md': '# API\n\nRun `npm install` then `npm start`, and open http://localhost:3000/api/parts.\n',
    },
  },
  {
    id: 'flask',
    name: 'Python + Flask API',
    description: 'Flask app on port 5000 (needs Python).',
    run: 'pip install -r requirements.txt && python app.py',
    files: {
      'requirements.txt': 'flask>=3.0\n',
      'app.py': "from flask import Flask, jsonify, request\n\napp = Flask(__name__)\nreadings = []\n\n@app.get('/api/readings')\ndef list_readings():\n    return jsonify(readings)\n\n@app.post('/api/readings')\ndef add_reading():\n    readings.append(request.get_json())\n    return jsonify(readings[-1]), 201\n\nif __name__ == '__main__':\n    app.run(port=5000, debug=True)\n",
    },
  },
  {
    id: 'fastapi',
    name: 'Python + FastAPI',
    description: 'Async API with automatic docs at /docs (needs Python).',
    run: 'pip install -r requirements.txt && python -m uvicorn main:app --reload --port 8000',
    files: {
      'requirements.txt': 'fastapi>=0.110\nuvicorn>=0.29\n',
      'main.py': "from fastapi import FastAPI\nfrom pydantic import BaseModel\n\napp = FastAPI()\n\nclass Item(BaseModel):\n    name: str\n    value: float\n\nitems: list[Item] = []\n\n@app.get('/items')\ndef get_items():\n    return items\n\n@app.post('/items')\ndef add_item(item: Item):\n    items.append(item)\n    return item\n",
    },
  },
  {
    id: 'static',
    name: 'Static website',
    description: 'HTML, CSS and JS served on port 8080 by the bundled Node runtime.',
    run: 'node serve.cjs',
    files: {
      'index.html': '<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>My site</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>Hello</h1>\n  <p id="t"></p>\n  <script src="app.js"></script>\n</body>\n</html>\n',
      'style.css': 'body { font-family: system-ui, sans-serif; margin: 3rem; }\n',
      'app.js': "document.getElementById('t').textContent = 'Loaded at ' + new Date().toLocaleTimeString();\n",
      'serve.cjs': "const http = require('http');\nconst fs = require('fs');\nconst path = require('path');\nconst types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };\nhttp.createServer((req, res) => {\n  const p = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));\n  if (!p.startsWith(__dirname)) return res.writeHead(403).end();\n  fs.readFile(p, (err, data) => {\n    if (err) return res.writeHead(404).end('Not found');\n    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' }).end(data);\n  });\n}).listen(8080, () => console.log('Serving on http://localhost:8080'));\n",
    },
  },
  {
    id: 'cmake',
    name: 'C++ with CMake',
    description: 'CMake project with a library and an executable.',
    run: 'cmake -S . -B build && cmake --build build && build\\app',
    files: {
      'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.16)\nproject(app CXX)\nset(CMAKE_CXX_STANDARD 17)\nadd_library(core src/core.cpp)\ntarget_include_directories(core PUBLIC include)\nadd_executable(app src/main.cpp)\ntarget_link_libraries(app core)\n',
      'include/core.hpp': '#pragma once\ndouble parallel(double a, double b);\n',
      'src/core.cpp': '#include "core.hpp"\ndouble parallel(double a, double b) { return a * b / (a + b); }\n',
      'src/main.cpp': '#include <iostream>\n#include "core.hpp"\nint main() { std::cout << "1k || 1k = " << parallel(1000, 1000) << " ohm\\n"; }\n',
    },
  },
  {
    id: 'pypkg',
    name: 'Python package + tests',
    description: 'src layout with pytest.',
    run: 'python -m pytest -q',
    files: {
      'pyproject.toml': '[project]\nname = "toolkit"\nversion = "0.1.0"\n\n[tool.pytest.ini_options]\npythonpath = ["src"]\n',
      'src/toolkit/__init__.py': 'def divider(vin: float, r1: float, r2: float) -> float:\n    """Output of a resistive divider."""\n    return vin * r2 / (r1 + r2)\n',
      'tests/test_divider.py': 'from toolkit import divider\n\ndef test_half():\n    assert divider(10, 1000, 1000) == 5\n',
    },
  },
  {
    id: 'arduino',
    name: 'Arduino sketch (arduino-cli)',
    description: 'Blink with a compile task for arduino-cli.',
    run: 'arduino-cli compile --fqbn arduino:avr:uno blink',
    files: {
      'blink/blink.ino': 'void setup() {\n  pinMode(LED_BUILTIN, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(LED_BUILTIN, HIGH);\n  delay(500);\n  digitalWrite(LED_BUILTIN, LOW);\n  delay(500);\n}\n',
    },
  },
];

export async function scaffold(root: string, templateId: string): Promise<string[]> {
  const t = PROJECT_TEMPLATES.find((x) => x.id === templateId);
  if (!t) throw new Error('Unknown template');
  const written: string[] = [];
  for (const [rel, text] of Object.entries(t.files)) {
    const p = safeJoin(root, rel);
    const exists = await stat(p).catch(() => null);
    if (exists) continue;
    await writeText(root, rel, text);
    written.push(relative(root, p));
  }
  return written;
}
