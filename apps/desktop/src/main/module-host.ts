import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AetherMainModule,
  EngineSession,
  FrameInjection,
  FrameStartHandler,
  FrameStartRequest,
  InternalPageHandler,
  MainHost,
  ModuleIpc,
  NavigationDecision,
  NavigationInterceptor,
  NavigationRequest,
  ProfilesApi,
  SessionContext,
  ShellEventName,
  ShellEvents,
  TabsApi,
} from '@aether/plugin-api';
import { BrowserWindow, dialog, net, Notification, safeStorage, shell } from 'electron';
import { pathToFileURL } from 'node:url';
import type { AetherStore } from '@aether/storage';
import type { ModuleManifest } from '@aether/plugin-api';
import { scopedModuleHost } from './module-sandbox';

type Listener<K extends ShellEventName> = (p: ShellEvents[K]) => void;
type ModuleHandler = Parameters<ModuleIpc['handle']>[1];

export interface ModuleHostDeps {
  store: AetherStore;
  userDataDir: string;
  registerInternalPage(name: string, handler: InternalPageHandler): void;
  existingSessions(): [EngineSession, SessionContext][];
  tabs: TabsApi;
  profiles: ProfilesApi;
  getIdleSeconds(): number;
  emitToUi(event: string, payload: unknown, windowId?: number): void;
  shellData?: MainHost['shellData'];
}

/** Renders trusted HTML to PDF in a hidden, script-free, offline window. */
async function htmlToPdf(dir: string, html: string, opts: { landscape?: boolean; pageSize?: 'A4' | 'Letter' } = {}): Promise<Uint8Array> {
  const file = join(dir, `print-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(file, html, 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'aether-print' } });
  try {
    // Block every network request: only the local file and inline data may load.
    win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !/^(file|data|blob):/.test(d.url) }));
    await win.loadURL(pathToFileURL(file).toString());
    const pdf = await win.webContents.printToPDF({ pageSize: opts.pageSize ?? 'A4', landscape: !!opts.landscape, printBackground: true, margins: { marginType: 'none' } });
    return new Uint8Array(pdf);
  } finally {
    win.destroy();
    rmSync(file, { force: true });
  }
}

const parentWindow = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

/**
 * Runs feature modules and isolates their failures: a throwing listener,
 * interceptor or activate() is logged and skipped, never fatal to the browser.
 */
/** Diagnostics only: AETHER_SKIP_SCRIPTLETS=<regex> drops matching scriptlets, to find one that breaks a site. */
const SKIP_SCRIPTLETS = (() => {
  try {
    return process.env.AETHER_SKIP_SCRIPTLETS ? new RegExp(process.env.AETHER_SKIP_SCRIPTLETS) : null;
  } catch {
    return null;
  }
})();

export class ModuleHost {
  private listeners = new Map<ShellEventName, Set<Listener<any>>>();
  private sessionListeners = new Set<(s: EngineSession, c: SessionContext) => void>();
  private interceptors: { moduleId: string; fn: NavigationInterceptor }[] = [];
  private frameHooks: { moduleId: string; fn: FrameStartHandler }[] = [];
  private handlers = new Map<string, ModuleHandler>();
  private modules: AetherMainModule[] = [];
  private installable = new Map<string, ModuleManifest>();
  private moduleGate: ((profileId: string, moduleId: string) => boolean) | null = null;

  constructor(private deps: ModuleHostDeps) {}

  emit<K extends ShellEventName>(name: K, payload: ShellEvents[K]): void {
    for (const l of this.listeners.get(name) ?? []) {
      try {
        l(payload);
      } catch (err) {
        console.error(`[modules] ${name} listener failed`, err);
      }
    }
  }

  sessionCreated(ses: EngineSession, ctx: SessionContext): void {
    for (const l of this.sessionListeners) {
      try {
        l(ses, ctx);
      } catch (err) {
        console.error('[modules] onSessionCreated listener failed', err);
      }
    }
  }

  hasInterceptors(): boolean {
    return this.interceptors.length > 0;
  }

  /** Runs interceptors in order; the first non-allow decision wins. Errors fail open (logged). */
  async decide(req: NavigationRequest): Promise<NavigationDecision> {
    for (const { moduleId, fn } of this.interceptors) {
      try {
        const d = await fn(req);
        if (d && d.action !== 'allow') return d;
      } catch (err) {
        console.error(`[modules] interceptor from ${moduleId} failed`, err);
      }
    }
    return { action: 'allow' };
  }

  /** Collects injections for a starting web frame. Failing hooks are skipped. */
  frameStart(req: FrameStartRequest): FrameInjection | null {
    let css = '';
    const scripts: string[] = [];
    for (const { moduleId, fn } of this.frameHooks) {
      try {
        const r = fn(req);
        if (r?.css) css += r.css + '\n';
        if (r?.scripts) scripts.push(...r.scripts.filter((code) => !SKIP_SCRIPTLETS?.test(code)));
      } catch (err) {
        console.error(`[modules] frame hook from ${moduleId} failed`, err);
      }
    }
    return css || scripts.length ? { css, scripts } : null;
  }

  async invoke(moduleId: string, method: string, payload: unknown, ctx: { windowId: number; profileId: string; isPrivate: boolean }): Promise<unknown> {
    if (this.installable.has(moduleId) && !this.moduleGate?.(ctx.profileId, moduleId)) throw new Error(`module-not-installed:${moduleId}`);
    const handler = this.handlers.get(`${moduleId}:${method}`);
    if (!handler) throw new Error(`No handler for ${moduleId}.${method}`);
    return handler(payload, ctx);
  }

  async load(modules: AetherMainModule[]): Promise<void> {
    for (const mod of modules) {
      if (!/^[a-z][a-z0-9.-]{0,47}$/.test(mod.id) || this.modules.some((m) => m.id === mod.id)) {
        console.error(`[modules] skipping module with invalid or duplicate id: ${mod.id}`);
        continue;
      }
      try {
        await mod.activate(this.hostFor(mod.id));
        this.modules.push(mod);
        console.info(`[modules] activated ${mod.id}`);
      } catch (err) {
        console.error(`[modules] failed to activate ${mod.id}`, err);
      }
    }
  }

  /**
   * Installable Modules get a scoped host (own database, network allow-list, process broker,
   * no session/frame/navigation hooks) and their IPC only answers profiles
   * that installed them.
   */
  async loadInstallable(list: { manifest: ModuleManifest; main: AetherMainModule }[], gate: (profileId: string, moduleId: string) => boolean): Promise<void> {
    this.moduleGate = gate;
    for (const { manifest, main } of list) {
      if (main.id !== manifest.id || this.modules.some((m) => m.id === main.id)) {
        console.error(`[modules] module ${manifest.id}: module id must equal manifest id and be unique`);
        continue;
      }
      try {
        const host = await scopedModuleHost(this.hostFor(manifest.id), manifest);
        await main.activate(host);
        this.modules.push(main);
        this.installable.set(manifest.id, manifest);
        console.info(`[modules] activated installable module ${manifest.id}`);
      } catch (err) {
        console.error(`[modules] failed to activate installable module ${manifest.id}`, err);
      }
    }
  }

  async unloadAll(): Promise<void> {
    for (const mod of this.modules.reverse()) {
      try {
        await mod.deactivate?.();
      } catch (err) {
        console.error(`[modules] failed to deactivate ${mod.id}`, err);
      }
    }
    this.modules = [];
  }

  private hostFor(moduleId: string): MainHost {
    const dataDir = join(this.deps.userDataDir, 'modules', moduleId);
    mkdirSync(dataDir, { recursive: true });
    const prefix = (msg: string) => `[${moduleId}] ${msg}`;
    const storage = this.deps.store.moduleStorage(moduleId);
    return {
      moduleId,
      dataDir,
      storage,
      sessions: {
        onSessionCreated: (listener) => {
          this.sessionListeners.add(listener);
          for (const [s, c] of this.deps.existingSessions()) {
            try {
              listener(s, c);
            } catch (err) {
              console.error(prefix('onSessionCreated listener failed'), err);
            }
          }
          return () => this.sessionListeners.delete(listener);
        },
      },
      navigation: {
        addInterceptor: (fn) => {
          const entry = { moduleId, fn };
          this.interceptors.push(entry);
          return () => {
            this.interceptors = this.interceptors.filter((e) => e !== entry);
          };
        },
      },
      internalPages: { register: (name, handler) => this.deps.registerInternalPage(name, handler) },
      events: {
        on: (name, listener) => {
          const set = this.listeners.get(name) ?? new Set();
          set.add(listener);
          this.listeners.set(name, set);
          return () => set.delete(listener);
        },
      },
      content: {
        onFrameStart: (fn) => {
          const entry = { moduleId, fn };
          this.frameHooks.push(entry);
          return () => {
            this.frameHooks = this.frameHooks.filter((e) => e !== entry);
          };
        },
      },
      tabs: this.deps.tabs,
      profiles: this.deps.profiles,
      ipc: {
        handle: (method, handler) => {
          if (!/^[a-zA-Z][\w.-]{0,63}$/.test(method)) throw new Error(`Invalid method name: ${method}`);
          this.handlers.set(`${moduleId}:${method}`, handler);
        },
        emit: (event, payload, windowId) => this.deps.emitToUi(`${moduleId}:${event}`, payload, windowId),
      },
      system: { getIdleSeconds: () => this.deps.getIdleSeconds() },
      net: { fetch: (url, init) => net.fetch(url, init) },
      secrets: {
        get available() {
          return safeStorage.isEncryptionAvailable();
        },
        get: (name) => {
          const enc = storage.kv.get<string>(`secret:${name}`);
          if (!enc || !safeStorage.isEncryptionAvailable()) return null;
          try {
            return safeStorage.decryptString(Buffer.from(enc, 'base64'));
          } catch {
            return null;
          }
        },
        set: (name, value) => {
          if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available; secret not stored');
          storage.kv.set(`secret:${name}`, safeStorage.encryptString(value).toString('base64'));
        },
        delete: (name) => storage.kv.delete(`secret:${name}`),
      },
      notifications: {
        show: ({ title, body, silent }) => {
          if (Notification.isSupported()) new Notification({ title, body, silent }).show();
        },
      },
      dialogs: {
        openFile: async (o = {}) => {
          const r = await dialog.showOpenDialog(parentWindow(), { title: o.title, filters: o.filters, properties: o.multi ? ['openFile', 'multiSelections'] : ['openFile'] });
          return r.canceled ? [] : r.filePaths;
        },
        openFolder: async (o = {}) => {
          const r = await dialog.showOpenDialog(parentWindow(), { title: o.title, properties: ['openDirectory', 'createDirectory'] });
          return r.canceled ? null : (r.filePaths[0] ?? null);
        },
        saveFile: async (o = {}) => {
          const r = await dialog.showSaveDialog(parentWindow(), { title: o.title, defaultPath: o.defaultPath, filters: o.filters });
          return r.canceled ? null : (r.filePath ?? null);
        },
      },
      openExternal: async (url) => {
        if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened externally');
        await shell.openExternal(url);
      },
      printToPdf: (html, opts) => htmlToPdf(dataDir, html, opts),
      shellData: this.deps.shellData,
      log: {
        info: (m, ...a) => console.info(prefix(m), ...a),
        warn: (m, ...a) => console.warn(prefix(m), ...a),
        error: (m, ...a) => console.error(prefix(m), ...a),
      },
    };
  }
}
