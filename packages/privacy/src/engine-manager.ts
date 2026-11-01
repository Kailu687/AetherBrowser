import { FiltersEngine } from '@ghostery/adblocker';
import { listsForCategories, type FilterListSource } from './lists.js';

export interface ListCategories {
  ads: boolean;
  tracking: boolean;
  annoyances: boolean;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type FetchLike = (url: string) => Promise<FetchResponseLike>;

/** Persists compiled engines so startup does not re-download or re-parse lists. */
export interface EngineCache {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, data: Uint8Array): Promise<void>;
}

/** A network request AETHER itself made, logged for the "requests made by the browser" panel. */
export interface BrowserRequestLogEntry {
  purpose: 'filter-list';
  url: string;
  at: number;
  ok: boolean;
  status?: number;
  bytes?: number;
  error?: string;
}

export interface ListLoadResult {
  id: string;
  name: string;
  ok: boolean;
  url?: string;
  error?: string;
}

export type EngineState = 'idle' | 'loading' | 'ready' | 'degraded' | 'unavailable';

export interface EngineStatus {
  key: string;
  state: EngineState;
  updatedAt?: number;
  fromCache: boolean;
  lists: ListLoadResult[];
  networkFilterCount: number;
}

export interface EngineManagerOptions {
  fetch: FetchLike;
  cache?: EngineCache;
  /** Lists older than this are refreshed in the background. Default 4 days. */
  maxAgeMs?: number;
  now?: () => number;
  onBrowserRequest?(entry: BrowserRequestLogEntry): void;
  /** Override the list catalogue (tests). */
  lists?: (categories: ListCategories) => FilterListSource[];
  /**
   * uBlock Origin resources (scriptlets and redirect payloads). Defaults to the
   * Ghostery mirror unless `lists` is overridden; [] disables.
   */
  resourcesUrls?: string[];
}

/**
 * Network and cosmetic filters. Cosmetic rules (element hiding and uBO
 * scriptlets) are injected by the shell's content hook at frame start.
 * Extended (procedural) selectors and HTML filtering are not supported.
 */
const ENGINE_CONFIG = {
  loadNetworkFilters: true,
  loadCosmeticFilters: true,
  loadExtendedSelectors: false,
  enableHtmlFiltering: false,
  enableCompression: true,
} as const;

const HEADER_BYTES = 8;
const RESOURCES_URL = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';

export function categoriesKey(c: ListCategories): string {
  return (['ads', 'tracking', 'annoyances'] as const).filter((k) => c[k]).join('+') || 'none';
}

interface Slot {
  engine?: FiltersEngine;
  loading?: Promise<FiltersEngine>;
  status: EngineStatus;
}

/**
 * Loads and caches one compiled engine per combination of list categories. Engines are
 * shared across profiles because filter lists are identical; per-profile behaviour
 * (exceptions, custom filters) lives in PrivacyProtection.
 */
export class FilterEngineManager {
  private readonly slots = new Map<string, Slot>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly listsFor: (c: ListCategories) => FilterListSource[];

  constructor(private readonly options: EngineManagerOptions) {
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? 4 * 24 * 3600 * 1000;
    this.listsFor = options.lists ?? listsForCategories;
    this.resourcesUrls = options.resourcesUrls ?? (options.lists ? [] : [RESOURCES_URL]);
  }
  private readonly resourcesUrls: string[];

  /** Returns the engine if it is already loaded; starts loading otherwise. Never blocks a request. */
  peek(categories: ListCategories): FiltersEngine | undefined {
    const slot = this.slot(categories);
    if (!slot.engine && !slot.loading) void this.load(categories).catch(() => undefined);
    return slot.engine;
  }

  /** Loads (from cache first) and resolves when the engine can be used. */
  load(categories: ListCategories): Promise<FiltersEngine> {
    const slot = this.slot(categories);
    if (slot.engine) return Promise.resolve(slot.engine);
    if (slot.loading) return slot.loading;
    slot.status.state = 'loading';
    slot.loading = this.loadInto(slot, categories).finally(() => {
      slot.loading = undefined;
    });
    return slot.loading;
  }

  /** Downloads fresh lists and swaps the engine in once compiled. */
  async refresh(categories: ListCategories): Promise<EngineStatus> {
    const slot = this.slot(categories);
    await this.download(slot, categories);
    return { ...slot.status };
  }

  status(categories: ListCategories): EngineStatus {
    const slot = this.slot(categories);
    // Counting decodes every filter, so do it on demand (settings panel) rather than at load.
    if (slot.engine && slot.status.networkFilterCount === 0) slot.status.networkFilterCount = countFilters(slot.engine);
    return { ...slot.status };
  }

  private slot(categories: ListCategories): Slot {
    const key = categoriesKey(categories);
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { status: { key, state: 'idle', fromCache: false, lists: [], networkFilterCount: 0 } };
      this.slots.set(key, slot);
    }
    return slot;
  }

  private async loadInto(slot: Slot, categories: ListCategories): Promise<FiltersEngine> {
    const cached = await this.readCache(slot.status.key);
    if (cached) {
      slot.engine = cached.engine;
      slot.status = {
        ...slot.status,
        state: 'ready',
        fromCache: true,
        updatedAt: cached.savedAt,
      };
      if (this.now() - cached.savedAt > this.maxAgeMs) void this.download(slot, categories).catch(() => undefined);
      return cached.engine;
    }
    return this.download(slot, categories);
  }

  private async download(slot: Slot, categories: ListCategories): Promise<FiltersEngine> {
    const sources = this.listsFor(categories);
    const texts: string[] = [];
    const results: ListLoadResult[] = [];
    await Promise.all(
      sources.map(async (source) => {
        const r = await this.fetchList(source);
        results.push(r.result);
        if (r.text) texts.push(r.text);
      }),
    );
    results.sort((a, b) => sources.findIndex((s) => s.id === a.id) - sources.findIndex((s) => s.id === b.id));
    const okCount = results.filter((r) => r.ok).length;
    if (okCount === 0 && sources.length > 0) {
      // Keep whatever engine we already had; a failed refresh must not remove protection.
      slot.status = { ...slot.status, lists: results, state: slot.engine ? slot.status.state : 'unavailable' };
      if (slot.engine) return slot.engine;
      const empty = FiltersEngine.empty(ENGINE_CONFIG);
      return empty;
    }
    const engine = FiltersEngine.parse(texts.join('\n'), ENGINE_CONFIG);
    const resources = await this.fetchResources();
    if (resources) {
      try {
        engine.updateResources(resources, String(resources.length));
      } catch {
        // Bad resources only disable scriptlets; element hiding and blocking still work.
      }
    }
    const savedAt = this.now();
    slot.engine = engine;
    slot.status = {
      key: slot.status.key,
      state: okCount === sources.length ? 'ready' : 'degraded',
      updatedAt: savedAt,
      fromCache: false,
      lists: results,
      networkFilterCount: 0,
    };
    await this.writeCache(slot.status.key, engine, savedAt);
    return engine;
  }

  private async fetchResources(): Promise<string | undefined> {
    for (const url of this.resourcesUrls) {
      const r = await this.fetchList({ id: 'resources', name: 'Scriptlet resources', category: 'ads', urls: [url], license: 'GPL-3.0', homepage: '' });
      if (r.text) return r.text;
    }
    return undefined;
  }

  private async fetchList(source: FilterListSource): Promise<{ result: ListLoadResult; text?: string }> {
    let lastError = 'No URL configured';
    for (const url of source.urls) {
      try {
        const res = await this.options.fetch(url);
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          this.options.onBrowserRequest?.({ purpose: 'filter-list', url, at: this.now(), ok: false, status: res.status });
          continue;
        }
        const text = await res.text();
        this.options.onBrowserRequest?.({ purpose: 'filter-list', url, at: this.now(), ok: true, status: res.status, bytes: text.length });
        return { result: { id: source.id, name: source.name, ok: true, url }, text };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.options.onBrowserRequest?.({ purpose: 'filter-list', url, at: this.now(), ok: false, error: lastError });
      }
    }
    return { result: { id: source.id, name: source.name, ok: false, error: lastError } };
  }

  private async readCache(key: string): Promise<{ engine: FiltersEngine; savedAt: number } | undefined> {
    if (!this.options.cache) return undefined;
    try {
      const data = await this.options.cache.read(key);
      if (!data || data.byteLength <= HEADER_BYTES) return undefined;
      const savedAt = Number(new DataView(data.buffer, data.byteOffset, HEADER_BYTES).getBigUint64(0));
      // deserialize throws on version mismatch or corruption; that just means re-download.
      const engine = FiltersEngine.deserialize(data.subarray(HEADER_BYTES));
      // Engines cached before cosmetic filtering was enabled are rebuilt.
      if (!engine.config.loadCosmeticFilters) return undefined;
      return { engine, savedAt };
    } catch {
      return undefined;
    }
  }

  private async writeCache(key: string, engine: FiltersEngine, savedAt: number): Promise<void> {
    if (!this.options.cache) return;
    try {
      const body = engine.serialize();
      const out = new Uint8Array(HEADER_BYTES + body.byteLength);
      new DataView(out.buffer).setBigUint64(0, BigInt(savedAt));
      out.set(body, HEADER_BYTES);
      await this.options.cache.write(key, out);
    } catch {
      // A cache write failure only costs startup time next launch.
    }
  }
}

function countFilters(engine: FiltersEngine): number {
  try {
    return engine.getFilters().networkFilters.length;
  } catch {
    return 0;
  }
}
