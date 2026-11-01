import { describe, expect, it } from 'vitest';
import { Request } from '@ghostery/adblocker';
import { FilterEngineManager, type BrowserRequestLogEntry } from '../src/index.js';
import { ADS_LIST, ALL_FILES, fakeFetch, memoryCache, testLists } from './fixtures.js';

const both = { ads: true, tracking: true, annoyances: false };
const blocks = (engine: any, url: string) =>
  engine.match(Request.fromRawDetails({ url, sourceUrl: 'https://site.test/', type: 'script' })).match;

describe('FilterEngineManager', () => {
  it('downloads lists, logs its own requests and caches the compiled engine', async () => {
    const log: BrowserRequestLogEntry[] = [];
    const cache = memoryCache();
    const m = new FilterEngineManager({ fetch: fakeFetch(ALL_FILES), lists: testLists, cache, onBrowserRequest: (e) => log.push(e), now: () => 5 });
    const engine = await m.load(both);
    expect(blocks(engine, 'https://tracker.example/x.js')).toBe(true);
    expect(m.status(both)).toMatchObject({ state: 'ready', fromCache: false, updatedAt: 5 });
    expect(m.status(both).networkFilterCount).toBeGreaterThan(3);
    expect(log.map((e) => [e.url, e.ok])).toEqual(
      expect.arrayContaining([['https://lists.test/ads.txt', true], ['https://lists.test/trk.txt', true]]),
    );
    expect(cache.store.has('ads+tracking')).toBe(true);
  });

  it('loads from cache without touching the network', async () => {
    const cache = memoryCache();
    await new FilterEngineManager({ fetch: fakeFetch(ALL_FILES), lists: testLists, cache, now: () => 100 }).load(both);
    const calls: string[] = [];
    const m = new FilterEngineManager({ fetch: fakeFetch(ALL_FILES, calls), lists: testLists, cache, now: () => 200 });
    const engine = await m.load(both);
    expect(blocks(engine, 'https://ads.example/x.js')).toBe(true);
    expect(calls).toEqual([]);
    expect(m.status(both)).toMatchObject({ fromCache: true, updatedAt: 100 });
  });

  it('refreshes a stale cache in the background', async () => {
    const cache = memoryCache();
    await new FilterEngineManager({ fetch: fakeFetch(ALL_FILES), lists: testLists, cache, now: () => 0 }).load(both);
    const calls: string[] = [];
    const m = new FilterEngineManager({ fetch: fakeFetch(ALL_FILES, calls), lists: testLists, cache, now: () => 10_000, maxAgeMs: 1000 });
    await m.load(both);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.length).toBe(2);
    expect(m.status(both).updatedAt).toBe(10_000);
  });

  it('ignores a corrupt cache entry and re-downloads', async () => {
    const cache = memoryCache();
    cache.store.set('ads+tracking', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 1, 9, 9, 9]));
    const m = new FilterEngineManager({ fetch: fakeFetch(ALL_FILES), lists: testLists, cache });
    expect(blocks(await m.load(both), 'https://ads.example/x.js')).toBe(true);
  });

  it('uses a mirror when the primary URL fails and reports degraded state when a list is missing', async () => {
    const m = new FilterEngineManager({ fetch: fakeFetch({ 'https://mirror.test/ads.txt': ADS_LIST }), lists: testLists });
    const engine = await m.load(both);
    expect(blocks(engine, 'https://ads.example/x.js')).toBe(true);
    const status = m.status(both);
    expect(status.state).toBe('degraded');
    expect(status.lists).toEqual([
      { id: 'ads', name: 'Ads', ok: true, url: 'https://mirror.test/ads.txt' },
      { id: 'trk', name: 'Tracking', ok: false, error: 'HTTP 404' },
    ]);
  });

  it('reports unavailable when offline with no cache, and keeps an existing engine on failed refresh', async () => {
    const offline = async () => { throw new Error('offline'); };
    const m = new FilterEngineManager({ fetch: offline, lists: testLists });
    await m.load(both);
    expect(m.status(both).state).toBe('unavailable');

    let online = true;
    const flaky = async (url: string) => {
      if (!online) throw new Error('offline');
      return fakeFetch(ALL_FILES)(url);
    };
    const m2 = new FilterEngineManager({ fetch: flaky, lists: testLists });
    const engine = await m2.load(both);
    online = false;
    await m2.refresh(both);
    expect(m2.peek(both)).toBe(engine);
    expect(m2.status(both).state).toBe('ready');
  });
});
