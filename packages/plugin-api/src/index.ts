/**
 * @aether/plugin-api
 *
 * The contract between the AETHER browser shell (apps/desktop) and feature
 * modules (privacy, focus, activity, research, writing, ...). Types only: this
 * package has no runtime code and must never import Electron, so modules can be
 * unit-tested in plain Node and the shell can evolve its engine integration
 * behind these interfaces.
 *
 * A feature ships two halves:
 *   - a main-process module  ({@link AetherMainModule}) that runs in the
 *     privileged Electron main process, and
 *   - optionally a renderer module ({@link AetherRendererModule}) that
 *     contributes React sidebar panels to the privileged browser UI.
 *
 * Website content never sees either half. Web pages run in sandboxed,
 * preload-free WebContentsViews; the only bridge to the privileged side is the
 * shell's narrow, validated IPC surface.
 */

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Minimal statement shape satisfied by node:sqlite and better-sqlite3. */
export interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** Minimal database shape satisfied by node:sqlite DatabaseSync and better-sqlite3. */
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
}

/** A forward-only schema migration owned by one module. */
export interface ModuleMigration {
  /** Monotonic version, starting at 1. */
  version: number;
  /** SQL executed inside a transaction. Tables MUST use the module's prefix. */
  up: string;
}

/** Storage handed to each module. Tables must be prefixed `<moduleId>_`. */
export interface ModuleStorage {
  /** Raw access to the shared local SQLite database. */
  db: SqlDatabase;
  /** Applies pending migrations for this module (tracked per module id). */
  migrate(migrations: ModuleMigration[]): void;
  /** Small JSON key/value store, scoped per module and optionally per profile. */
  kv: {
    get<T = unknown>(key: string, profileId?: string): T | undefined;
    set(key: string, value: unknown, profileId?: string): void;
    delete(key: string, profileId?: string): void;
  };
}

// ---------------------------------------------------------------------------
// Context objects
// ---------------------------------------------------------------------------

export interface ProfileInfo {
  id: string;
  name: string;
  color: string;
  /** Electron session partition string, e.g. "persist:profile-<id>". */
  partition: string;
  isPrivate: boolean;
}

export interface TabContext {
  tabId: number;
  windowId: number;
  url: string;
  title: string;
  profileId: string;
  workspaceId: string | null;
  isPrivate: boolean;
}

/**
 * Structural subset of Electron's Session handed to modules. Typed loosely on
 * purpose so modules do not need an Electron dependency; at runtime it is the
 * real `Electron.Session`.
 */
export interface EngineSession {
  webRequest: unknown;
  // Real object is Electron.Session; cast in modules that need more.
  [key: string]: unknown;
}

export interface SessionContext {
  profileId: string;
  partition: string;
  isPrivate: boolean;
}

// ---------------------------------------------------------------------------
// Events emitted by the shell
// ---------------------------------------------------------------------------

export interface ShellEvents {
  /** A window gained or lost OS focus. */
  windowFocusChanged: { windowId: number; focused: boolean; profileId: string; isPrivate: boolean };
  /** A window was minimized or restored. */
  windowMinimized: { windowId: number; minimized: boolean };
  /** The active tab in a window changed (or the window opened). */
  activeTabChanged: TabContext;
  /** A tab committed a main-frame navigation (including in-page navigations). */
  tabNavigated: TabContext & { inPage: boolean };
  /** A tab started or stopped playing audio. */
  tabAudible: TabContext & { audible: boolean };
  /** A tab was closed. */
  tabClosed: { tabId: number; windowId: number };
  /** A window was closed. */
  windowClosed: { windowId: number };
  /** A main-frame load failed (DNS, TLS, refused...). `code` is a Chromium net error. */
  tabLoadFailed: TabContext & { code: number; description: string; failedUrl: string };
  /** A profile was deleted; modules must delete their rows for it. */
  profileDeleted: { profileId: string };
  /** The OS is suspending / locking (pause timers) or resuming / unlocking. */
  systemSuspended: { reason: 'suspend' | 'lock-screen' };
  systemResumed: { reason: 'resume' | 'unlock-screen' };
  /** The app is about to quit; flush state synchronously. */
  appWillQuit: Record<string, never>;
}

export type ShellEventName = keyof ShellEvents;

export interface ShellEventBus {
  on<K extends ShellEventName>(name: K, listener: (payload: ShellEvents[K]) => void): () => void;
}

// ---------------------------------------------------------------------------
// Navigation interception (used by focus rules, safe browsing, etc.)
// ---------------------------------------------------------------------------

export interface NavigationRequest {
  url: string;
  /** "omnibox" = typed/selected by the user; "link" = page navigation; "new-tab" = window.open/target=_blank; "restore" = session restore. */
  source: 'omnibox' | 'link' | 'new-tab' | 'restore' | 'module';
  tab: TabContext | null;
  profileId: string;
  workspaceId: string | null;
  isPrivate: boolean;
}

export type NavigationDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'redirect'; url: string };

/**
 * Called before the shell starts a top-level navigation it initiates or
 * observes (omnibox, link clicks, popups, restores). Interceptors run in
 * registration order; the first non-allow decision wins.
 *
 * Subresource and server-redirect interception belongs to the web request
 * hub registered via {@link SessionHooks}.
 */
export type NavigationInterceptor = (req: NavigationRequest) => NavigationDecision | Promise<NavigationDecision>;

// ---------------------------------------------------------------------------
// Internal pages (aether://<name>/...)
// ---------------------------------------------------------------------------

export type InternalPageResponse =
  | { html: string; /** Allow http(s) images (reader views). Scripts stay blocked. */ allowRemoteImages?: boolean }
  | { redirect: string }
  | { status?: number; body: string | Uint8Array; contentType?: string; headers?: Record<string, string> };

/**
 * Handler for `aether://<name>/...`. Internal pages are served into ordinary
 * unprivileged, sandboxed web views. They have no IPC and no preload; any
 * action they need must be a plain GET to another aether:// URL that the
 * handler answers with a redirect.
 */
export type InternalPageHandler = (url: URL, ctx: SessionContext) => InternalPageResponse | Promise<InternalPageResponse>;

// ---------------------------------------------------------------------------
// The host object a main-process module receives
// ---------------------------------------------------------------------------

export interface SessionHooks {
  /**
   * Called for every profile and private-window session, including ones
   * created before the module activated. The shell itself registers no
   * webRequest listeners; modules own them (via @aether/web-request-hub).
   */
  onSessionCreated(listener: (session: EngineSession, ctx: SessionContext) => void): () => void;
}

export interface TabsApi {
  getActive(windowId: number): TabContext | null;
  get(tabId: number): TabContext | null;
  list(windowId?: number): TabContext[];
  open(windowId: number, url: string, opts?: { background?: boolean }): number | null;
  navigate(tabId: number, url: string): void;
  /** Maps a webRequest `webContentsId` back to its tab, if it belongs to one. */
  fromWebContentsId(webContentsId: number): TabContext | null;
  /** Extracts readable text and citation metadata from a tab (isolated world, read-only). */
  getPageContent(tabId: number): Promise<PageContent | null>;
  /** Saves the tab as a single-file web archive (MHTML). Resolves false if the tab has no page. */
  savePage?(tabId: number, filePath: string): Promise<boolean>;
}

export interface PageContent {
  url: string;
  title: string;
  text: string;
  /** <meta> name/property -> content values (citation_*, dc.*, og:*, description, ...). Repeated keys keep all values. */
  meta: Record<string, string[]>;
  /** DOIs found in meta tags or the URL. */
  dois: string[];
  /** Currently selected text, if any. */
  selection: string;
}

/** A web frame starting to load, as reported by the shell's content hook. */
export interface FrameStartRequest {
  url: string;
  /** URL of the top-level page ('' if unknown). */
  topLevelUrl: string;
  isMainFrame: boolean;
  profileId: string;
  partition: string;
  isPrivate: boolean;
  /** Set on the follow-up call made once the DOM exists: names seen in the page. */
  dom?: { classes: string[]; ids: string[]; hrefs: string[] };
}

/** What to inject into the frame: CSS as a user stylesheet, scripts into the page's main world. */
export interface FrameInjection {
  css?: string;
  scripts?: string[];
}

/**
 * Runs before page scripts in every web frame (synchronously for the first
 * call, so keep handlers fast). Used for cosmetic filtering and scriptlets.
 * Scripts run in the page's own JavaScript world: only inject trusted code.
 */
export type FrameStartHandler = (req: FrameStartRequest) => FrameInjection | null | undefined;

export interface ProfilesApi {
  list(): ProfileInfo[];
  get(profileId: string): ProfileInfo | null;
}

export interface ModuleIpc {
  /**
   * Registers a handler reachable from the privileged UI as
   * `aether.module.invoke(moduleId, method, payload)`. Payloads are
   * structured-cloned JSON; validate them in the handler.
   */
  handle(method: string, handler: (payload: unknown, ctx: { windowId: number; profileId: string; isPrivate: boolean }) => unknown | Promise<unknown>): void;
  /** Pushes an event to the privileged UI of every window (or one window). */
  emit(event: string, payload: unknown, windowId?: number): void;
}

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface MainHost {
  readonly moduleId: string;
  readonly storage: ModuleStorage;
  readonly sessions: SessionHooks;
  readonly navigation: { addInterceptor(interceptor: NavigationInterceptor): () => void };
  readonly internalPages: { register(name: string, handler: InternalPageHandler): void };
  readonly events: ShellEventBus;
  readonly tabs: TabsApi;
  readonly profiles: ProfilesApi;
  readonly ipc: ModuleIpc;
  readonly system: { getIdleSeconds(): number };
  /** Network fetch from the main process (Electron net.fetch; default session, no profile cookies). */
  readonly net: { fetch(url: string, init?: RequestInit): Promise<Response> };
  /**
   * Small secrets (API keys) encrypted with the OS keychain (Electron safeStorage:
   * DPAPI on Windows). Scoped per module. `available` is false when the OS
   * offers no encryption, in which case set() throws rather than storing plaintext.
   */
  readonly secrets?: {
    readonly available: boolean;
    get(name: string): string | null;
    set(name: string, value: string): void;
    delete(name: string): void;
  };
  /** Injection into web frames at document start (cosmetic filtering). */
  readonly content?: { onFrameStart(handler: FrameStartHandler): () => void };
  /** Native OS notification. */
  readonly notifications: { show(opts: { title: string; body?: string; silent?: boolean }): void };
  readonly log: Logger;
  /** Absolute directory reserved for this module's files (inside userData). */
  readonly dataDir: string;
  /** Native file dialogs (privileged UI only; the result is a path the user picked). */
  readonly dialogs?: {
    openFile(opts?: { title?: string; filters?: { name: string; extensions: string[] }[]; multi?: boolean }): Promise<string[]>;
    openFolder(opts?: { title?: string }): Promise<string | null>;
    saveFile(opts?: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
  };
  /** Opens an http(s) URL in the OS default browser (used for OAuth). */
  readonly openExternal?: (url: string) => Promise<void>;
  /** Renders trusted HTML (scripts disabled) to a PDF. */
  readonly printToPdf?: (html: string, opts?: { landscape?: boolean; pageSize?: 'A4' | 'Letter' }) => Promise<Uint8Array>;
  /** Local programs (Modules with `process.run` / `process.servers`, and Studio after consent). */
  readonly processes?: ProcessService;
  /** Native confirmation for risky one-off actions; resolves false if the user declines. */
  readonly approvals?: { confirm(opts: { title: string; detail: string; risk: 'low' | 'medium' | 'high'; confirmLabel?: string }): Promise<boolean> };
  /** Optional AI gateway (Modules with `ai.optional`); null when AI is off. */
  readonly ai?: { run(req: { system?: string; prompt: string; scope: 'selection' | 'page' | 'pdf' | 'note' | 'draft' | 'references' }): Promise<{ text: string } | null> };
  /** Shell-level helpers exposed to the Google account module (core only). */
  readonly shellData?: {
    exportSyncData(profileId: string): Record<string, unknown>;
    importSyncData(profileId: string, data: Record<string, unknown>): { added: number };
  };
}

// ---------------------------------------------------------------------------
// Modules (installable add-ons): manifest, permissions and the privileged services they may use
// ---------------------------------------------------------------------------

/**
 * What a Module may ask for. Anything else is unreachable from a Module: cookies,
 * saved passwords, history, other modules' tables, session hooks, frame
 * injection and navigation interception are core-only.
 *
 * - `storage`      own SQLite file, kv and dataDir. Always granted.
 * - `net:<host>`   host.net.fetch to that exact host (https only). `net:*.example.org` allows subdomains.
 * - `net:localhost` http(s) to loopback on any port (local dev servers, local kernels).
 * - `net:user`     any http(s) host the user typed; the core confirms each new host with the user.
 * - `tabs.read`    host.tabs.getPageContent / savePage, only after a user action in the Module's UI.
 * - `files.pick`   host.dialogs.openFile / saveFile (the user picks the path).
 * - `files.folder` host.dialogs.openFolder, then read/write inside that folder only.
 * - `process.run`  host.processes.run: an installed program, argv only (no shell), time limit; the user approves each program once.
 * - `process.servers` host.processes.start: long-running commands incl. a shell (Developer terminal). High risk.
 * - `ai.optional`  host.ai when the user has turned AI on and consented for that scope.
 * - `secrets`      host.secrets (OS-encrypted API keys, scoped to the Module).
 */
export type ModulePermission =
  | 'storage'
  | `net:${string}`
  | 'tabs.read'
  | 'files.pick'
  | 'files.folder'
  | 'process.run'
  | 'process.servers'
  | 'ai.optional'
  | 'secrets';

export interface ModuleAppInfo {
  id: string;
  title: string;
  icon: string;
  description: string;
}

export type ModuleCategory = 'research' | 'electronics' | 'developer' | 'software' | 'mechanical' | 'aerospace' | 'civil' | 'bio' | 'rf' | 'data' | 'math' | 'other';

/** An external program a Module can drive when it is installed (it is never bundled). */
export interface ModuleExternalApp {
  /** Program name looked up on PATH, e.g. "ngspice". */
  program: string;
  name: string;
  /** What works without it. */
  optional: boolean;
  purpose: string;
  url?: string;
}

/**
 * Module manifest (schema 2). Exported as `manifest` from the Module package's
 * src/index.ts. The core shows it in the Module Store, checks compatibility,
 * OS and dependencies, asks the user to approve `permissions`, and enforces them.
 */
export interface ModuleManifest {
  manifest: 2;
  /** Also the main module id and IPC namespace: `aether.module.<name>`. */
  id: string;
  name: string;
  /** Semver of the Module. */
  version: string;
  layer: 'module';
  category: ModuleCategory;
  icon: string;
  /** Accent colour for the store card. */
  color: string;
  tagline: string;
  description: string;
  /** Compatible AETHER versions, e.g. ">=0.4.0 <0.6.0" or "^0.4.0". */
  engines: { aether: string };
  /** Supported OSes; omitted = all. */
  os?: ('win32' | 'darwin' | 'linux')[];
  /** Other Modules this one builds on: id -> semver range. */
  dependencies?: Record<string, string>;
  /** Programs it can use if installed on the PC (shown before install, checked with processes.which). */
  externalApps?: ModuleExternalApp[];
  permissions: ModulePermission[];
  /** 'none' = fully offline. */
  network: 'none' | 'some';
  features: { title: string; detail: string; online?: boolean }[];
  /** Honest list of what it cannot do; shown before install. */
  limits: string[];
  apps: ModuleAppInfo[];
  /** SPDX licence id of the Module's code, e.g. "MIT". */
  license: string;
  /** Approximate install size in MB (code + bundled data). */
  sizeMb?: number;
  /** Newest first. */
  changelog?: { version: string; date: string; notes: string[] }[];
  /** Security advisories for this Module (shown in the store). */
  advisories?: { id: string; severity: 'low' | 'medium' | 'high'; affected: string; summary: string }[];
  /** Optional sha256 of the Module's source, filled at pack time; the core shows it and re-checks the manifest digest. */
  integrity?: string;
}

/** @deprecated use ModulePermission (Labs were renamed Modules in contract v2). */
export type LabPermission = ModulePermission;
/** @deprecated use ModuleAppInfo. */
export type LabAppInfo = ModuleAppInfo;
/** @deprecated use ModuleManifest. */
export type LabManifest = ModuleManifest;

/** Result of a program run through host.processes. */
export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Running local programs. Only present for Modules granted `process.run`
 * (and `process.servers` for start()). The core resolves `program` on PATH,
 * asks the user once per program ("Allow Electronics & ECE to run ngspice?"),
 * never uses a shell for run(), caps output, and kills on timeout.
 */
export interface ProcessService {
  /** Is the program installed? Returns its resolved path and version line if found. */
  which(program: string): Promise<{ path: string; version?: string } | null>;
  run(program: string, args: string[], opts?: { cwd?: string; stdin?: string; timeoutMs?: number }): Promise<ProcessResult>;
  /** Long-running command (needs `process.servers`). Output and exit arrive as `process.output` / `process.exit` events. */
  start?(command: string, opts: { cwd: string; name?: string; shell?: boolean }): Promise<{ id: string }>;
  input?(id: string, text: string): boolean;
  stop?(id: string): boolean;
  on?(event: 'output' | 'exit' | 'port', listener: (p: { id: string; stream?: 'stdout' | 'stderr'; chunk?: string; code?: number | null; port?: number }) => void): () => void;
}

export interface AetherMainModule {
  /** Lowercase identifier, [a-z][a-z0-9.-]* (e.g. "aether.protection"). Also the IPC namespace; tables use a prefix derived from it. */
  id: string;
  activate(host: MainHost): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Renderer side (privileged browser UI)
// ---------------------------------------------------------------------------

export interface ActiveTabSnapshot {
  tabId: number | null;
  url: string;
  title: string;
  profileId: string;
  workspaceId: string | null;
  isPrivate: boolean;
}

export interface PanelApi {
  /** Calls the main-process half of this module. */
  invoke<T = unknown>(method: string, payload?: unknown): Promise<T>;
  /** Subscribes to events emitted by host.ipc.emit. Returns an unsubscribe function. */
  on(event: string, listener: (payload: unknown) => void): () => void;
  /** Opens a URL in a new tab of the current window. */
  openUrl(url: string): void;
  activeTab: ActiveTabSnapshot;
}

/**
 * A sidebar panel. `component` is a React component typed loosely so this
 * package does not depend on React: (props: { api: PanelApi }) => ReactNode.
 */
export interface SidebarPanelDefinition {
  id: string;
  title: string;
  /** Short glyph or emoji shown in the sidebar rail. */
  icon: string;
  component: unknown;
  /** Preferred width in px (default 360). */
  width?: number;
  /** Only shown when this add-on pack is installed. */
  addon?: string;
}

/** API handed to full-size Workbench apps (Writer, IDE, Circuit lab ...). */
export interface WorkbenchAppApi extends PanelApi {
  /** Calls another module's main-process half (e.g. the research library). */
  invokeModule<T = unknown>(moduleId: string, method: string, payload?: unknown): Promise<T>;
  /** Saves data as a file through the download flow. */
  download(name: string, data: Blob | string, mime?: string): void;
  /** Opens another Workbench app, optionally with an argument (e.g. a document id). */
  openApp(appId: string, arg?: string): void;
  /** Argument the app was opened with, if any. */
  arg?: string;
}

/**
 * A full-size app shown in the Workbench, which covers the web view or sits
 * beside it (split). component: (props: { api: WorkbenchAppApi }) => ReactNode.
 */
export interface WorkbenchAppDefinition {
  id: string;
  title: string;
  /** Short glyph or emoji for the launcher. */
  icon: string;
  description?: string;
  component: unknown;
  /** Only shown when this add-on pack is installed. Omit for built-in apps. */
  addon?: string;
}

export interface AetherRendererModule {
  /** For a Lab: the manifest id. Its apps and panels are hidden until the Lab is installed. */
  id: string;
  panels?: SidebarPanelDefinition[];
  apps?: WorkbenchAppDefinition[];
}
