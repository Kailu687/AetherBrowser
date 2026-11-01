import { describe, expect, it } from 'vitest';
import { WebRequestHub, type RequestContext } from '@aether/web-request-hub';
import {
  FilterEngineManager,
  PrivacyProtection,
  applyPreset,
  defaultPrivacySettings,
  updateSettings,
} from '../src/index.js';
import { ALL_FILES, fakeFetch, testLists } from './fixtures.js';

async function setup(patch: Parameters<typeof updateSettings>[1] = {}, custom = '') {
  const engines = new FilterEngineManager({ fetch: fakeFetch(ALL_FILES), lists: testLists });
  let saved: unknown;
  const settings = { ...updateSettings(defaultPrivacySettings(), patch), customFilters: custom };
  const p = new PrivacyProtection({ engines, settings, onSettingsChanged: (s) => (saved = s), now: () => 1000 });
  await engines.load(settings.lists);
  const hub = new WebRequestHub();
  p.attachTo(hub, 'profile-1');
  return { p, hub, engines, saved: () => saved };
}

const ctx = (over: Partial<RequestContext>): RequestContext => ({
  id: 1,
  url: 'https://tracker.example/t.js',
  method: 'GET',
  resourceType: 'script',
  webContentsId: 7,
  topLevelUrl: 'https://news.site/article',
  referrer: '',
  sessionKey: 'profile-1',
  ...over,
});

describe('PrivacyProtection request blocking', () => {
  it('blocks third-party trackers and ads and counts them per tab', async () => {
    const { hub, p } = await setup();
    await hub.runBeforeRequest(ctx({ resourceType: 'mainFrame', url: 'https://news.site/article' }));
    expect(await hub.runBeforeRequest(ctx({}))).toEqual({ cancel: true });
    expect(await hub.runBeforeRequest(ctx({ url: 'https://ads.example/b.png', resourceType: 'image' }))).toEqual({ cancel: true });
    expect(await hub.runBeforeRequest(ctx({ url: 'https://cdn.news.site/app.js' }))).toEqual({});
    const tab = p.stats.forTab(7)!;
    expect(tab.blocked).toBe(2);
    expect(tab.recent.map((r) => r.host)).toEqual(['tracker.example', 'ads.example']);
    expect(tab.recent[0]!.filter).toContain('tracker.example');
  });

  it('honours list exception rules', async () => {
    const { hub } = await setup();
    expect(await hub.runBeforeRequest(ctx({ url: 'https://ads.example/allowed.js' }))).toEqual({});
  });

  it('never blocks the top-level page itself', async () => {
    const { hub } = await setup();
    expect(await hub.runBeforeRequest(ctx({ resourceType: 'mainFrame', url: 'https://ads.example/', topLevelUrl: 'https://ads.example/' }))).toEqual({});
  });

  it('respects $third-party: first-party tracker requests pass', async () => {
    const { hub } = await setup();
    expect(await hub.runBeforeRequest(ctx({ topLevelUrl: 'https://www.tracker.example/' }))).toEqual({});
  });

  it('resets per-tab counts when the tab navigates', async () => {
    const { hub, p } = await setup();
    await hub.runBeforeRequest(ctx({}));
    expect(p.stats.forTab(7)!.blocked).toBe(1);
    await hub.runBeforeRequest(ctx({ resourceType: 'mainFrame', url: 'https://other.site/' }));
    expect(p.stats.forTab(7)!.blocked).toBe(0);
    expect(p.stats.total()).toBe(1);
  });

  it('relaxes protection for one broken site without affecting others', async () => {
    const { hub, p, saved } = await setup();
    p.setSiteException('https://www.news.site/page', { disableBlocking: true });
    expect(await hub.runBeforeRequest(ctx({}))).toEqual({});
    expect(await hub.runBeforeRequest(ctx({ topLevelUrl: 'https://blog.other/' }))).toEqual({ cancel: true });
    expect((saved() as any).siteExceptions).toEqual({ 'news.site': { disableBlocking: true } });
    expect(p.panelState(7, 'https://news.site/').blockingActive).toBe(false);
    p.setSiteException('news.site', null);
    expect(await hub.runBeforeRequest(ctx({}))).toEqual({ cancel: true });
  });

  it('does nothing when protection is switched off', async () => {
    const { hub, p } = await setup();
    p.setSettings({ ...p.getSettings(), enabled: false });
    expect(await hub.runBeforeRequest(ctx({}))).toEqual({});
  });

  it('applies user custom filters and custom allow rules', async () => {
    const { hub } = await setup({}, '||cdn.news.site/ads/*\n@@||tracker.example/needed.js');
    expect(await hub.runBeforeRequest(ctx({ url: 'https://cdn.news.site/ads/x.js' }))).toEqual({ cancel: true });
    expect(await hub.runBeforeRequest(ctx({ url: 'https://tracker.example/needed.js' }))).toEqual({});
  });

  it('only handles requests from its own profile session', async () => {
    const { hub } = await setup();
    expect(await hub.runBeforeRequest(ctx({ sessionKey: 'other-profile' }))).toEqual({});
  });

  it('ignores non-http requests', async () => {
    const { hub } = await setup();
    expect(await hub.runBeforeRequest(ctx({ url: 'aether://newtab/' }))).toEqual({});
  });
});

describe('PrivacyProtection navigation hardening', () => {
  it('upgrades http main frames to https in strict mode and falls back after failure', async () => {
    const { hub, p } = await setup(applyPreset(defaultPrivacySettings(), 'strict'));
    const r = await hub.runBeforeRequest(ctx({ resourceType: 'mainFrame', url: 'http://example.org/a?b=1' }));
    expect(r).toEqual({ redirectURL: 'https://example.org/a?b=1' });
    await hub.runBeforeRequest(ctx({ resourceType: 'mainFrame', url: 'https://example.org/a?b=1' }));
    expect(p.stats.forTab(7)!.upgradedToHttps).toBe(true);
    expect(p.reportHttpsFailure('https://example.org/a?b=1')).toBe('http://example.org/a?b=1');
    expect(await hub.runBeforeRequest(ctx({ resourceType: 'mainFrame', url: 'http://example.org/a?b=1' }))).toEqual({});
  });

  it('does not upgrade local network hosts', async () => {
    const { hub } = await setup({ httpsUpgrade: true });
    expect(await hub.runBeforeRequest(ctx({ resourceType: 'mainFrame', url: 'http://192.168.1.1/' }))).toEqual({});
    expect(await hub.runBeforeRequest(ctx({ resourceType: 'mainFrame', url: 'http://localhost:3000/' }))).toEqual({});
  });

  it('removes click-tracking parameters from navigations', async () => {
    const { hub } = await setup();
    const r = await hub.runBeforeRequest(ctx({ resourceType: 'mainFrame', url: 'https://shop.test/p?id=4&utm_source=x&fbclid=abc#top' }));
    expect(r).toEqual({ redirectURL: 'https://shop.test/p?id=4#top' });
    const r2 = await hub.runBeforeRequest(ctx({ resourceType: 'mainFrame', url: 'https://shop.test/p?gclid=1' }));
    expect(r2).toEqual({ redirectURL: 'https://shop.test/p' });
  });
});

describe('PrivacyProtection headers', () => {
  it('adds the Global Privacy Control header', async () => {
    const { hub } = await setup();
    expect(hub.runBeforeSendHeaders(ctx({}), {})).toEqual({ 'Sec-GPC': '1' });
  });

  it('strips cookies only on third-party requests when enabled', async () => {
    const { hub, p } = await setup({ blockThirdPartyCookies: true, sendGlobalPrivacyControl: false });
    expect(hub.runBeforeSendHeaders(ctx({ url: 'https://cdn.embed.com/w.js' }), { Cookie: 'a=1' })).toEqual({});
    expect(hub.runBeforeSendHeaders(ctx({ url: 'https://api.news.site/x' }), { cookie: 'a=1' })).toEqual({ cookie: 'a=1' });
    expect(hub.runHeadersReceived(ctx({ url: 'https://cdn.embed.com/w.js' }), { 'set-cookie': ['a=1'], 'content-type': ['js'] }, 200)).toEqual({ 'content-type': ['js'] });
    expect(p.stats.forTab(7)!.cookiesStripped).toBe(2);
    p.setSiteException('news.site', { allowThirdPartyCookies: true });
    expect(hub.runBeforeSendHeaders(ctx({ url: 'https://cdn.embed.com/w.js' }), { Cookie: 'a=1' })).toEqual({ Cookie: 'a=1' });
  });

  it('leaves cookies alone in balanced mode', async () => {
    const { hub } = await setup({ sendGlobalPrivacyControl: false });
    expect(hub.runBeforeSendHeaders(ctx({ url: 'https://cdn.embed.com/w.js' }), { Cookie: 'a=1' })).toEqual({ Cookie: 'a=1' });
  });
});

describe('cosmetic filtering', () => {
  it('returns hiding CSS from user rules, and nothing when blocking is off for the site', async () => {
    const { p } = await setup({}, 'example.com##.promo-box\n##.ad-slot');
    const site = p.cosmeticsFor('https://example.com/a', 'https://example.com/a');
    expect(site?.css).toContain('.promo-box');
    const dom = p.cosmeticsFor('https://other.test/', 'https://other.test/', { classes: ['ad-slot'], ids: [], hrefs: [] });
    expect(dom?.css).toContain('.ad-slot');
    p.setSiteException('https://example.com/', { disableBlocking: true });
    expect(p.cosmeticsFor('https://example.com/a', 'https://example.com/a')).toBeNull();
    expect(p.cosmeticsFor('aether://newtab/', '')).toBeNull();
  });

  it('can turn off element hiding or scriptlets for one site', async () => {
    const { p } = await setup({}, 'example.com##.promo-box\n##.ad-slot');
    p.setSiteException('https://example.com/', { disableCosmetics: true });
    expect(p.exceptionFor('https://example.com/x')).toEqual({ disableCosmetics: true });
    expect(p.cosmeticsFor('https://example.com/a', 'https://example.com/a')).toBeNull();
    expect(p.cosmeticsFor('https://example.com/a', 'https://example.com/a', { classes: ['ad-slot'] })).toBeNull();
    expect(p.cosmeticsFor('https://other.test/', 'https://other.test/', { classes: ['ad-slot'] })?.css).toContain('.ad-slot');
    p.setSiteException('https://example.com/', { disableScriptlets: true });
    expect(p.cosmeticsFor('https://example.com/a', 'https://example.com/a')?.css).toContain('.promo-box');
  });
});

