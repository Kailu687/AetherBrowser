import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { app, dialog, type BrowserWindow } from 'electron';

/**
 * Local-folder updates. New builds are dropped into a "releases" folder on
 * this PC with a manifest:
 *
 *   releases/latest.json  {"version":"0.3.0","file":"AETHER-Setup-0.3.0.exe","sha256":"...","notes":"..."}
 *
 * AETHER checks it at start and every 30 minutes; when a newer version is
 * there it offers to restart into it, verifies the SHA-256, and runs the
 * installer silently. Nothing is downloaded from the internet.
 */

export interface UpdateManifest {
  version: string;
  file: string;
  sha256: string;
  notes?: string;
}

/** Compares dotted versions numerically: 1 if a > b, -1 if a < b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function parseManifest(text: string): UpdateManifest | null {
  try {
    const m = JSON.parse(text) as Partial<UpdateManifest>;
    if (typeof m.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(m.version)) return null;
    if (typeof m.file !== 'string' || basename(m.file) !== m.file || !/^[\w .()-]+\.exe$/i.test(m.file)) return null;
    if (typeof m.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(m.sha256)) return null;
    return { version: m.version, file: m.file, sha256: m.sha256.toLowerCase(), notes: typeof m.notes === 'string' ? m.notes.slice(0, 2000) : undefined };
  } catch {
    return null;
  }
}

const sha256 = (path: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });

export class LocalUpdater {
  private timer: NodeJS.Timeout | null = null;
  private declined = new Set<string>();
  private busy = false;

  constructor(
    private dir: () => string | null,
    private window: () => BrowserWindow | null,
  ) {}

  /** Default: the project folder's "releases" directory, if it exists. */
  static defaultDir(): string | null {
    const candidates = [process.env.AETHER_UPDATE_DIR, join(homedir(), 'Desktop', 'Projects', 'Aether Browser', 'releases')].filter((x): x is string => !!x);
    return candidates.find((d) => existsSync(d)) ?? null;
  }

  start(): void {
    if (process.platform !== 'win32' || !app.isPackaged) return;
    setTimeout(() => void this.check(), 15_000);
    this.timer = setInterval(() => void this.check(), 30 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async available(): Promise<UpdateManifest | null> {
    const dir = this.dir();
    if (!dir) return null;
    const text = await readFile(join(dir, 'latest.json'), 'utf8').catch(() => null);
    const m = text ? parseManifest(text) : null;
    return m && compareVersions(m.version, app.getVersion()) > 0 && existsSync(join(dir, m.file)) ? m : null;
  }

  async check(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const m = await this.available();
      if (!m || this.declined.has(m.version)) return;
      const win = this.window();
      const opts = {
        type: 'info' as const,
        message: `AETHER ${m.version} is ready to install`,
        detail: `${m.notes ? `${m.notes}\n\n` : ''}AETHER will close, update and reopen with your windows and tabs restored.`,
        buttons: ['Restart and update', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      if (response !== 0) {
        this.declined.add(m.version);
        return;
      }
      await this.install(m);
    } catch (err) {
      console.error('[updater] check failed', err);
    } finally {
      this.busy = false;
    }
  }

  private async install(m: UpdateManifest): Promise<void> {
    const path = join(this.dir()!, m.file);
    const actual = await sha256(path);
    if (actual !== m.sha256) {
      await dialog.showMessageBox({ type: 'error', message: 'Update not installed', detail: `${m.file} does not match its checksum, so AETHER did not run it.` });
      return;
    }
    // Silent per-user install; --force-run relaunches AETHER when it finishes.
    spawn(path, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  }
}
