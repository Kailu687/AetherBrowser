/**
 * File access guard.
 *
 * The module may only touch files the user picked in a dialog (files.pick) or
 * files inside a folder the user picked (files.folder), plus its own dataDir.
 * Paths are resolved with realpath so `..` and symlinks cannot escape a
 * granted folder. Grants live in memory for this session and in the module's
 * own database for folders the user chose to remember.
 */
import { realpathSync, statSync } from 'node:fs';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DataError, LIMITS } from './table.js';

function canonical(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    // Not existing yet (a save target): canonicalise the parent.
    try {
      return join(realpathSync.native(dirname(abs)), abs.slice(dirname(abs).length + 1));
    } catch {
      return abs;
    }
  }
}

function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

export class FileGuard {
  private files = new Set<string>();
  private folders = new Set<string>();
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = canonical(dataDir);
  }

  grantFile(p: string): string {
    const c = canonical(p);
    this.files.add(norm(c));
    return c;
  }

  grantFolder(p: string): string {
    const c = canonical(p);
    if (c === dirname(c)) throw new DataError('folder', 'Choose a folder, not the whole drive.');
    this.folders.add(norm(c));
    return c;
  }

  revokeFolder(p: string): void {
    this.folders.delete(norm(canonical(p)));
  }

  listFolders(): string[] {
    return [...this.folders];
  }

  /** Throws unless the path is a granted file, inside a granted folder, or inside dataDir. */
  check(p: unknown): string {
    if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) throw new DataError('path', 'Invalid path.');
    if (!isAbsolute(p)) throw new DataError('path', 'Path must be absolute.');
    const c = canonical(p);
    const n = norm(c);
    if (this.files.has(n)) return c;
    if (within(norm(this.dataDir), n)) return c;
    for (const f of this.folders) if (within(f, n)) return c;
    throw new DataError('path-denied', 'AETHER can only open files you picked or files inside a folder you chose.');
  }

  async read(p: unknown, maxBytes: number = LIMITS.maxFileBytes): Promise<{ path: string; bytes: Uint8Array }> {
    const path = this.check(p);
    const st = statSync(path);
    if (!st.isFile()) throw new DataError('path', 'Not a file.');
    if (st.size > maxBytes) throw new DataError('too-large', `File is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    // Re-check after resolving in case it was swapped for a link between check and open.
    const real = await realpath(path);
    this.check(real);
    return { path: real, bytes: new Uint8Array(await readFile(real)) };
  }

  async write(p: unknown, data: string | Uint8Array): Promise<string> {
    const path = this.check(p);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    return path;
  }

  /** A path inside dataDir (for the module's own files). Rejects traversal in the name. */
  inData(...parts: string[]): string {
    for (const part of parts) if (!/^[A-Za-z0-9._-]{1,128}$/.test(part) || part === '.' || part === '..') throw new DataError('path', `Bad file name ${part}`);
    return join(this.dataDir, ...parts);
  }

  get root(): string {
    return this.dataDir;
  }
}
