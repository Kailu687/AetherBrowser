export type PrivacyPreset = 'balanced' | 'strict' | 'custom';

export interface SiteException {
  /** Turn request blocking off on this site (the page and everything it loads). */
  disableBlocking?: boolean;
  /** Let this site's embedded third parties keep their cookies. */
  allowThirdPartyCookies?: boolean;
  /** Skip the automatic http to https upgrade. */
  disableHttpsUpgrade?: boolean;
  /** Keep blocking requests but stop running uBlock scriptlets on this site. */
  disableScriptlets?: boolean;
  /** Keep blocking requests but stop hiding page elements on this site. */
  disableCosmetics?: boolean;
}

export interface PrivacySettings {
  preset: PrivacyPreset;
  /** Master switch. When false nothing is blocked or modified. */
  enabled: boolean;
  lists: { ads: boolean; tracking: boolean; annoyances: boolean };
  blockThirdPartyCookies: boolean;
  httpsUpgrade: boolean;
  stripTrackingParams: boolean;
  /** Sends the Sec-GPC: 1 request header (Global Privacy Control). */
  sendGlobalPrivacyControl: boolean;
  /** User filters in Adblock Plus / uBlock syntax, one per line. */
  customFilters: string;
  /** Keyed by registrable domain of the top-level page, e.g. "example.co.uk". */
  siteExceptions: Record<string, SiteException>;
}

type PresetValues = Omit<PrivacySettings, 'preset' | 'customFilters' | 'siteExceptions' | 'enabled'>;

export const PRESETS: Record<Exclude<PrivacyPreset, 'custom'>, PresetValues> = {
  balanced: {
    lists: { ads: true, tracking: true, annoyances: false },
    blockThirdPartyCookies: false,
    httpsUpgrade: false,
    stripTrackingParams: true,
    sendGlobalPrivacyControl: true,
  },
  strict: {
    lists: { ads: true, tracking: true, annoyances: true },
    blockThirdPartyCookies: true,
    httpsUpgrade: true,
    stripTrackingParams: true,
    sendGlobalPrivacyControl: true,
  },
};

export function defaultPrivacySettings(): PrivacySettings {
  return { preset: 'balanced', enabled: true, ...clone(PRESETS.balanced), customFilters: '', siteExceptions: {} };
}

/** Applies a preset while keeping the user's own filters and site exceptions. */
export function applyPreset(settings: PrivacySettings, preset: PrivacyPreset): PrivacySettings {
  if (preset === 'custom') return { ...settings, preset };
  return { ...settings, ...clone(PRESETS[preset]), preset };
}

/** Changes individual options; the preset becomes "custom" if the result no longer matches it. */
export function updateSettings(settings: PrivacySettings, patch: Partial<PresetValues>): PrivacySettings {
  const next = { ...settings, ...patch, lists: { ...settings.lists, ...(patch.lists ?? {}) } };
  return { ...next, preset: detectPreset(next) };
}

export function detectPreset(settings: PrivacySettings): PrivacyPreset {
  for (const name of ['balanced', 'strict'] as const) {
    const p = PRESETS[name];
    if (
      p.lists.ads === settings.lists.ads &&
      p.lists.tracking === settings.lists.tracking &&
      p.lists.annoyances === settings.lists.annoyances &&
      p.blockThirdPartyCookies === settings.blockThirdPartyCookies &&
      p.httpsUpgrade === settings.httpsUpgrade &&
      p.stripTrackingParams === settings.stripTrackingParams &&
      p.sendGlobalPrivacyControl === settings.sendGlobalPrivacyControl
    )
      return name;
  }
  return 'custom';
}

export const SETTINGS_EXPORT_FORMAT = 'aether.privacy-settings';

/** Settings contain no credentials or browsing data, so the whole object is exportable. */
export function exportSettings(settings: PrivacySettings): string {
  return JSON.stringify({ format: SETTINGS_EXPORT_FORMAT, version: 1, settings }, null, 2);
}

export class SettingsImportError extends Error {}

/** Parses an exported file. Unknown keys are dropped and every value is type-checked. */
export function importSettings(json: string): PrivacySettings {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new SettingsImportError('The file is not valid JSON.');
  }
  if (!isObject(data) || data.format !== SETTINGS_EXPORT_FORMAT || !isObject(data.settings))
    throw new SettingsImportError('The file is not an AETHER privacy settings export.');
  return sanitizeSettings(data.settings);
}

export function sanitizeSettings(raw: Record<string, unknown>): PrivacySettings {
  const d = defaultPrivacySettings();
  const lists = isObject(raw.lists) ? raw.lists : {};
  const out: PrivacySettings = {
    preset: 'custom',
    enabled: bool(raw.enabled, d.enabled),
    lists: {
      ads: bool(lists.ads, d.lists.ads),
      tracking: bool(lists.tracking, d.lists.tracking),
      annoyances: bool(lists.annoyances, d.lists.annoyances),
    },
    blockThirdPartyCookies: bool(raw.blockThirdPartyCookies, d.blockThirdPartyCookies),
    httpsUpgrade: bool(raw.httpsUpgrade, d.httpsUpgrade),
    stripTrackingParams: bool(raw.stripTrackingParams, d.stripTrackingParams),
    sendGlobalPrivacyControl: bool(raw.sendGlobalPrivacyControl, d.sendGlobalPrivacyControl),
    customFilters: typeof raw.customFilters === 'string' ? raw.customFilters.slice(0, 1_000_000) : '',
    siteExceptions: {},
  };
  if (isObject(raw.siteExceptions)) {
    for (const [site, ex] of Object.entries(raw.siteExceptions)) {
      if (!isObject(ex) || !/^[a-z0-9.-]{1,253}$/i.test(site)) continue;
      const clean: SiteException = {};
      if (ex.disableBlocking === true) clean.disableBlocking = true;
      if (ex.allowThirdPartyCookies === true) clean.allowThirdPartyCookies = true;
      if (ex.disableHttpsUpgrade === true) clean.disableHttpsUpgrade = true;
      if (ex.disableScriptlets === true) clean.disableScriptlets = true;
      if (ex.disableCosmetics === true) clean.disableCosmetics = true;
      if (Object.keys(clean).length) out.siteExceptions[site.toLowerCase()] = clean;
    }
  }
  out.preset = detectPreset(out);
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
