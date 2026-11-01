import type { FilterListSource } from '../src/index.js';

export const ADS_LIST = `
! test ads list
||ads.example^
||doubleclick.net^$third-party
/banner-ad.
@@||ads.example/allowed.js
`;
export const TRACKING_LIST = `
||tracker.example^$third-party
||google-analytics.com^
`;

export const testLists = (c: { ads: boolean; tracking: boolean; annoyances: boolean }): FilterListSource[] =>
  [
    { id: 'ads', name: 'Ads', category: 'ads' as const, urls: ['https://lists.test/ads.txt', 'https://mirror.test/ads.txt'], license: 'test', homepage: '' },
    { id: 'trk', name: 'Tracking', category: 'tracking' as const, urls: ['https://lists.test/trk.txt'], license: 'test', homepage: '' },
  ].filter((l) => c[l.category]);

export function fakeFetch(files: Record<string, string>, calls: string[] = []) {
  return async (url: string) => {
    calls.push(url);
    const body = files[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
}

export const ALL_FILES = { 'https://lists.test/ads.txt': ADS_LIST, 'https://lists.test/trk.txt': TRACKING_LIST };

export function memoryCache() {
  const store = new Map<string, Uint8Array>();
  return { store, read: async (k: string) => store.get(k), write: async (k: string, v: Uint8Array) => void store.set(k, v) };
}
