import { describe, expect, it } from 'vitest';
import { Request } from '@ghostery/adblocker';
import { FilterEngineManager } from '../src/index.js';

// Downloads the real lists; run with AETHER_NETWORK_TESTS=1.
describe.runIf(process.env.AETHER_NETWORK_TESTS === '1')('real filter lists', () => {
  it('blocks well-known ad and analytics endpoints and keeps first-party content', async () => {
    const m = new FilterEngineManager({ fetch: (u) => fetch(u) });
    const lists = { ads: true, tracking: true, annoyances: false };
    const engine = await m.load(lists);
    const status = m.status(lists);
    console.log('list status', JSON.stringify(status.lists), 'filters', status.networkFilterCount);
    expect(status.lists.some((l) => l.ok)).toBe(true);
    const match = (url: string, type = 'script') =>
      engine.match(Request.fromRawDetails({ url, sourceUrl: 'https://www.example-news.com/', type: type as any })).match;
    expect(match('https://securepubads.g.doubleclick.net/tag/js/gpt.js')).toBe(true);
    expect(match('https://www.google-analytics.com/analytics.js')).toBe(true);
    expect(match('https://www.example-news.com/static/app.js')).toBe(false);
  }, 120_000);

  it('hides ads with cosmetic rules and loads YouTube scriptlets', async () => {
    const { PrivacyProtection, defaultPrivacySettings } = await import('../src/index.js');
    const engines = new FilterEngineManager({ fetch: (u) => fetch(u) });
    const p = new PrivacyProtection({ engines, settings: defaultPrivacySettings() });
    await engines.load(defaultPrivacySettings().lists);
    const yt = p.cosmeticsFor('https://www.youtube.com/watch?v=x', 'https://www.youtube.com/watch?v=x');
    console.log('youtube scripts', yt?.scripts.length, 'css bytes', yt?.css.length);
    expect(yt?.scripts.length).toBeGreaterThan(0);
    const generic = p.cosmeticsFor('https://news.example/', 'https://news.example/', { classes: ['ad_banner', 'article'], ids: [], hrefs: [] });
    expect(generic?.css).toContain('.ad_banner');
  }, 120_000);
});
