/**
 * Electron allows exactly one listener per webRequest event per session; a second
 * registration silently replaces the first. The hub owns those listeners and runs an
 * ordered list of handlers so that focus rules, ad blocking and cookie policies can
 * coexist on the same session.
 *
 * Types here are structural subsets of Electron's so this package has no runtime
 * dependency on Electron and can be unit-tested in plain Node.
 */

export type ResourceType =
  | 'mainFrame'
  | 'subFrame'
  | 'stylesheet'
  | 'script'
  | 'image'
  | 'font'
  | 'object'
  | 'xhr'
  | 'ping'
  | 'cspReport'
  | 'media'
  | 'webSocket'
  | 'other';

export type HeaderMap = Record<string, string | string[]>;

/** Subset of Electron's OnBeforeRequestListenerDetails (and siblings). */
export interface ElectronRequestDetails {
  id: number;
  url: string;
  method: string;
  resourceType: string;
  referrer: string;
  timestamp: number;
  webContentsId?: number;
  webContents?: { getURL(): string } | null;
  frame?: { url: string; top?: { url: string } | null } | null;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string[]>;
  statusCode?: number;
}

type Callback<R> = (response: R) => void;

/** Subset of Electron's WebRequest. */
export interface WebRequestLike {
  onBeforeRequest(
    listener: ((details: ElectronRequestDetails, callback: Callback<{ cancel?: boolean; redirectURL?: string }>) => void) | null,
  ): void;
  onBeforeSendHeaders(
    listener:
      | ((details: ElectronRequestDetails, callback: Callback<{ cancel?: boolean; requestHeaders?: Record<string, string | string[]> }>) => void)
      | null,
  ): void;
  onHeadersReceived(
    listener:
      | ((details: ElectronRequestDetails, callback: Callback<{ cancel?: boolean; responseHeaders?: Record<string, string[]> }>) => void)
      | null,
  ): void;
}

/** Subset of Electron's Session. */
export interface SessionLike {
  webRequest: WebRequestLike;
}

/** Normalised view of a request handed to every handler. */
export interface RequestContext {
  id: number;
  url: string;
  method: string;
  resourceType: ResourceType;
  webContentsId: number | undefined;
  /** URL of the top-level document the request belongs to (the request URL itself for main frames). */
  topLevelUrl: string;
  referrer: string;
  /** Key that identifies which session (normally the profile id) the request came from. */
  sessionKey: string;
}

export type BeforeRequestResult = { cancel: true } | { redirectURL: string } | void;

export interface RequestHandler {
  /** Shown in error logs. */
  name: string;
  /** Return cancel/redirect to stop the chain. Returning nothing passes to the next handler. */
  onBeforeRequest?(ctx: RequestContext): BeforeRequestResult | Promise<BeforeRequestResult>;
  /** Mutate or return replacement request headers. */
  onBeforeSendHeaders?(ctx: RequestContext, headers: Record<string, string>): Record<string, string> | void;
  /** Mutate or return replacement response headers. */
  onHeadersReceived?(ctx: RequestContext, headers: Record<string, string[]>, statusCode: number): Record<string, string[]> | void;
}

export interface HubOptions {
  /** Called when a handler throws. Requests always proceed (fail open) so a handler bug never hangs a page. */
  onError?(handler: string, error: unknown): void;
}

const KNOWN_TYPES = new Set<ResourceType>([
  'mainFrame',
  'subFrame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xhr',
  'ping',
  'cspReport',
  'media',
  'webSocket',
  'other',
]);

export function normaliseResourceType(type: string): ResourceType {
  return KNOWN_TYPES.has(type as ResourceType) ? (type as ResourceType) : 'other';
}

export function resolveTopLevelUrl(details: ElectronRequestDetails): string {
  if (details.resourceType === 'mainFrame') return details.url;
  const fromFrame = details.frame?.top?.url ?? (details.resourceType === 'subFrame' ? undefined : details.frame?.url);
  if (fromFrame) return fromFrame;
  try {
    const fromContents = details.webContents?.getURL();
    if (fromContents) return fromContents;
  } catch {
    // webContents may already be destroyed.
  }
  return details.referrer || '';
}

export function toContext(details: ElectronRequestDetails, sessionKey: string): RequestContext {
  return {
    id: details.id,
    url: details.url,
    method: details.method,
    resourceType: normaliseResourceType(details.resourceType),
    webContentsId: details.webContentsId,
    topLevelUrl: resolveTopLevelUrl(details),
    referrer: details.referrer,
    sessionKey,
  };
}

export class WebRequestHub {
  private readonly handlers: RequestHandler[] = [];
  private readonly attached = new Map<SessionLike, string>();

  constructor(private readonly options: HubOptions = {}) {}

  /**
   * Adds a handler. Handlers run in registration order unless `first` is set (focus
   * rules use it so interventions happen before blocking). Returns an unsubscribe function.
   */
  use(handler: RequestHandler, opts: { first?: boolean } = {}): () => void {
    if (opts.first) this.handlers.unshift(handler);
    else this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  /** Installs the hub's listeners on a session. `sessionKey` is passed to handlers (use the profile id). */
  attach(session: SessionLike, sessionKey: string): void {
    if (this.attached.has(session)) throw new Error(`Session for "${sessionKey}" is already attached`);
    this.attached.set(session, sessionKey);
    session.webRequest.onBeforeRequest((details, callback) => {
      this.runBeforeRequest(toContext(details, sessionKey)).then(callback, () => callback({}));
    });
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = this.runBeforeSendHeaders(toContext(details, sessionKey), { ...(details.requestHeaders ?? {}) });
      callback({ requestHeaders: headers });
    });
    session.webRequest.onHeadersReceived((details, callback) => {
      if (!details.responseHeaders) return callback({});
      const headers = this.runHeadersReceived(toContext(details, sessionKey), cloneHeaders(details.responseHeaders), details.statusCode ?? 0);
      callback({ responseHeaders: headers });
    });
  }

  detach(session: SessionLike): void {
    if (!this.attached.delete(session)) return;
    session.webRequest.onBeforeRequest(null);
    session.webRequest.onBeforeSendHeaders(null);
    session.webRequest.onHeadersReceived(null);
  }

  async runBeforeRequest(ctx: RequestContext): Promise<{ cancel?: boolean; redirectURL?: string }> {
    for (const handler of [...this.handlers]) {
      if (!handler.onBeforeRequest) continue;
      try {
        const result = await handler.onBeforeRequest(ctx);
        if (result && 'cancel' in result && result.cancel) return { cancel: true };
        if (result && 'redirectURL' in result) return { redirectURL: result.redirectURL };
      } catch (error) {
        this.options.onError?.(handler.name, error);
      }
    }
    return {};
  }

  runBeforeSendHeaders(ctx: RequestContext, headers: Record<string, string>): Record<string, string> {
    let current = headers;
    for (const handler of [...this.handlers]) {
      if (!handler.onBeforeSendHeaders) continue;
      try {
        current = handler.onBeforeSendHeaders(ctx, current) ?? current;
      } catch (error) {
        this.options.onError?.(handler.name, error);
      }
    }
    return current;
  }

  runHeadersReceived(ctx: RequestContext, headers: Record<string, string[]>, statusCode: number): Record<string, string[]> {
    let current = headers;
    for (const handler of [...this.handlers]) {
      if (!handler.onHeadersReceived) continue;
      try {
        current = handler.onHeadersReceived(ctx, current, statusCode) ?? current;
      } catch (error) {
        this.options.onError?.(handler.name, error);
      }
    }
    return current;
  }
}

function cloneHeaders(headers: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = Array.isArray(v) ? [...v] : [String(v)];
  return out;
}

/** Case-insensitive header lookup helpers shared by handlers. */
export function findHeaderKey(headers: Record<string, unknown>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.keys(headers).find((k) => k.toLowerCase() === lower);
}

export function deleteHeader(headers: Record<string, unknown>, name: string): boolean {
  const key = findHeaderKey(headers, name);
  if (key === undefined) return false;
  delete headers[key];
  return true;
}
