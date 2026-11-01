export type FetchLike = (input: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface LookupOptions {
  fetch?: FetchLike;
  /** Crossref "polite pool" contact; only sent if the user configured it. */
  mailto?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class LookupError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "network" | "invalid-input" | "parse" | "offline",
    readonly status?: number,
  ) {
    super(message);
    this.name = "LookupError";
  }
}

export async function getJson(url: string, opts: LookupOptions, headers: Record<string, string> = {}): Promise<unknown> {
  return request(url, opts, headers, (r) => r.json());
}

export async function getText(url: string, opts: LookupOptions, headers: Record<string, string> = {}): Promise<string> {
  return request(url, opts, headers, (r) => r.text());
}

async function request<T>(url: string, opts: LookupOptions, headers: Record<string, string>, read: (r: Awaited<ReturnType<FetchLike>>) => Promise<T>): Promise<T> {
  const f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!f) throw new LookupError("No fetch implementation available", "offline");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
  opts.signal?.addEventListener("abort", () => ctrl.abort());
  try {
    const res = await f(url, { headers, signal: ctrl.signal });
    if (res.status === 404) throw new LookupError(`Not found: ${url}`, "not-found", 404);
    if (!res.ok) throw new LookupError(`HTTP ${res.status} from ${new URL(url).host}`, "network", res.status);
    try {
      return await read(res);
    } catch (e) {
      throw new LookupError(`Could not parse response from ${new URL(url).host}: ${(e as Error).message}`, "parse");
    }
  } catch (e) {
    if (e instanceof LookupError) throw e;
    throw new LookupError(`Network error contacting ${new URL(url).host}: ${(e as Error).message}`, "network");
  } finally {
    clearTimeout(timer);
  }
}
