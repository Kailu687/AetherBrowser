import { describe, expect, it } from 'vitest';
import {
  SettingsImportError,
  applyPreset,
  defaultPrivacySettings,
  exportSettings,
  importSettings,
  updateSettings,
  stripTrackingParams,
  FILTER_LISTS,
} from '../src/index.js';

describe('privacy settings', () => {
  it('defaults to the balanced preset', () => {
    const s = defaultPrivacySettings();
    expect(s.preset).toBe('balanced');
    expect(s.lists).toEqual({ ads: true, tracking: true, annoyances: false });
    expect(s.blockThirdPartyCookies).toBe(false);
  });

  it('switches presets but keeps user filters and exceptions', () => {
    const s = { ...defaultPrivacySettings(), customFilters: '||x.com^', siteExceptions: { 'a.com': { disableBlocking: true } } };
    const strict = applyPreset(s, 'strict');
    expect(strict).toMatchObject({ preset: 'strict', blockThirdPartyCookies: true, httpsUpgrade: true, customFilters: '||x.com^' });
    expect(strict.siteExceptions).toEqual(s.siteExceptions);
  });

  it('becomes custom when an option diverges from the preset', () => {
    const s = updateSettings(defaultPrivacySettings(), { blockThirdPartyCookies: true });
    expect(s.preset).toBe('custom');
    expect(updateSettings(s, { blockThirdPartyCookies: false }).preset).toBe('balanced');
  });

  it('round-trips through export and import', () => {
    const s = { ...applyPreset(defaultPrivacySettings(), 'strict'), siteExceptions: { 'uni.ac.in': { allowThirdPartyCookies: true } } };
    expect(importSettings(exportSettings(s))).toEqual(s);
  });

  it('rejects malformed files and drops invalid values', () => {
    expect(() => importSettings('not json')).toThrow(SettingsImportError);
    expect(() => importSettings('{"format":"other"}')).toThrow(SettingsImportError);
    const s = importSettings(
      JSON.stringify({
        format: 'aether.privacy-settings',
        settings: {
          enabled: 'yes',
          lists: { ads: false },
          customFilters: 42,
          siteExceptions: { 'bad site!': { disableBlocking: true }, 'ok.com': { disableBlocking: 'true', allowThirdPartyCookies: true }, 'x.com': {} },
          password: 'hunter2',
        },
      }),
    );
    expect(s.enabled).toBe(true);
    expect(s.lists.ads).toBe(false);
    expect(s.customFilters).toBe('');
    expect(s.siteExceptions).toEqual({ 'ok.com': { allowThirdPartyCookies: true } });
    expect(s).not.toHaveProperty('password');
  });

  it('lists every filter list with a licence and an https source', () => {
    for (const l of FILTER_LISTS) {
      expect(l.license).toBeTruthy();
      expect(l.urls.every((u) => u.startsWith('https://'))).toBe(true);
    }
  });

  it('leaves URLs without tracking params untouched', () => {
    expect(stripTrackingParams('https://a.com/?q=utm')).toBeUndefined();
    expect(stripTrackingParams('not a url')).toBeUndefined();
  });
});
