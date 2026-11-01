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
}

export interface AetherRendererModule {
  id: string;
  panels?: SidebarPanelDefinition[];
}
