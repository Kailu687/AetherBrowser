import type { NetworkLogEntry } from "./model.js";

/** The subset of fetch the module needs. host.net.fetch satisfies it. */
export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export class NetError extends Error {
  constructor(
    message: string,
    readonly kind: "offline" | "blocked" | "not-found" | "http" | "network" | "timeout" | "too-large" | "parse" | "rate-limited",
    readonly status?: number,
  ) {
    super(message);
    this.name = "NetError";
  }
}

/** Hosts the module may contact. Mirrors the manifest's net: permissions; the core enforces the same list. */
export const ALLOWED_HOSTS = ["api.crossref.org", "api.openalex.org", "export.arxiv.org", "api.semanticscholar.org", "eutils.ncbi.nlm.nih.gov", "doi.org", "data.crossref.org", "api.datacite.org"] as const;

/** Minimum spacing between requests per host, following each service's published guidance. */
const MIN_INTERVAL_MS: Record<string, number> = {
  "export.arxiv.org": 3000, // arXiv asks for one request every 3 seconds
  "api.semanticscholar.org": 1100, // ~1 request/second without a key
  "eutils.ncbi.nlm.nih.gov": 350, // NCBI: at most 3 requests/second without an API key
  "api.crossref.org": 120,
  "api.openalex.org": 120,
  "doi.org": 120,
};

const MAX_BYTES = 5_000_000;

export interface LabNetOptions {
  fetch: FetchLike;
  /** Returns false when the user has online features switched off. */
  isOnline: () => boolean;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (e: NetworkLogEntry) => void;
}

/**
 * Every network request the module makes goes through here. It enforces, in
 * addition to the core's own checks: the online switch, https only, a fixed
 * host allowlist, per-host pacing, a timeout and a response-size cap. Each
 * request is logged as metadata (service, host, what was sent, status),
 * never with the response body.
 */
export class LabNet {
  private readonly next = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: LabNetOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async getText(url: string, meta: { service: string; purpose: string; sent: string; headers?: Record<string, string> }): Promise<string> {
    const started = this.now();
    let host = "";
    const record = (status: NetworkLogEntry["status"]) =>
      this.opts.log?.({ at: new Date(started).toISOString(), service: meta.service, host, purpose: meta.purpose, sent: meta.sent.slice(0, 500), status, ms: this.now() - started });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new NetError(`Invalid URL`, "blocked");
    }
    host = parsed.host;
    if (!this.opts.isOnline()) throw new NetError("Online features are off. Turn them on in Research & Writing module settings.", "offline");
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
      record("blocked");
      throw new NetError(`Blocked non-https request to ${host}`, "blocked");
    }
    if (!(ALLOWED_HOSTS as readonly string[]).includes(parsed.hostname)) {
      record("blocked");
      throw new NetError(`Blocked request to ${parsed.hostname}: not in the Research & Writing module's allowed hosts`, "blocked");
    }
    // Pace requests per host.
    const wait = (this.next.get(host) ?? 0) - this.now();
    this.next.set(host, Math.max(this.now(), this.next.get(host) ?? 0) + (MIN_INTERVAL_MS[host] ?? 200));
    if (wait > 0) await this.sleep(wait);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15_000);
    try {
      const res = await this.opts.fetch(parsed.toString(), { headers: { Accept: "application/json, application/atom+xml;q=0.9, */*;q=0.1", ...(meta.headers ?? {}) }, signal: ctrl.signal });
      record(res.status);
      if (res.status === 404) throw new NetError(`Not found at ${host}`, "not-found", 404);
      if (res.status === 429) throw new NetError(`${host} is rate-limiting requests; try again in a minute.`, "rate-limited", 429);
      if (!res.ok) throw new NetError(`HTTP ${res.status} from ${host}`, "http", res.status);
      const len = Number(res.headers?.get("content-length") ?? 0);
      if (len > MAX_BYTES) throw new NetError(`Response from ${host} is too large`, "too-large");
      const body = await res.text();
      if (body.length > MAX_BYTES) throw new NetError(`Response from ${host} is too large`, "too-large");
      return body;
    } catch (e) {
      if (e instanceof NetError) throw e;
      record("error");
      if (ctrl.signal.aborted) throw new NetError(`${host} did not answer in time`, "timeout");
      throw new NetError(`Could not reach ${host}: ${(e as Error).message}`, "network");
    } finally {
      clearTimeout(timer);
    }
  }

  async getJson<T = unknown>(url: string, meta: { service: string; purpose: string; sent: string; headers?: Record<string, string> }): Promise<T> {
    const text = await this.getText(url, meta);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new NetError(`Unexpected response from ${new URL(url).host}`, "parse");
    }
  }
}
