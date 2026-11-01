import { FiltersEngine, Request } from '@ghostery/adblocker';
import { deleteHeader, findHeaderKey, type RequestContext, type RequestHandler, type WebRequestHub } from '@aether/web-request-hub';
import type { FilterEngineManager, EngineStatus } from './engine-manager.js';
import { defaultPrivacySettings, type PrivacySettings, type SiteException } from './settings.js';
import { PrivacyStats, type TabStats } from './stats.js';
import { hostOf, httpsUpgrade, isHttpUrl, siteOf, stripTrackingParams } from './url-utils.js';

export interface PanelState {
  enabled: boolean;
  preset: PrivacySettings['preset'];
  site: string;
  exception: SiteException;
  /** True when request blocking is active for the current page. */
  blockingActive: boolean;
  engine: EngineStatus;
  tab: TabStats | undefined;
}

export interface PrivacyProtectionOptions {
  engines: FilterEngineManager;
  settings?: PrivacySettings;
  /** Called after any settings change so the shell can persist them for this profile. */
  onSettingsChanged?(settings: PrivacySettings): void;
  now?: () => number;
}

/** Ad, tracker and cookie protection for one profile (one Electron session). */
export class PrivacyProtection {
  readonly stats = new PrivacyStats();
  private settings: PrivacySettings;
  private customEngines: { block: FiltersEngine; allow: FiltersEngine } | undefined;
  private customEngineSource = '';
  private customCosmetic: { source: string; engine: FiltersEngine } | undefined;
  private readonly httpsFailedHosts = new Set<string>();
  /** https URLs this profile recently produced by upgrading http, for fallback on failure. */
  private readonly recentUpgrades = new Map<string, number>();
  private readonly pendingFlags = new Map<number, { upgradedToHttps?: boolean; trackingParamsRemoved?: boolean }>();
  private readonly now: () => number;

  constructor(private readonly options: PrivacyProtectionOptions) {
    this.settings = options.settings ?? defaultPrivacySettings();
    this.now = options.now ?? Date.now;
  }

  getSettings(): PrivacySettings {
    return this.settings;
  }

  setSettings(settings: PrivacySettings): void {
    this.settings = settings;
    this.options.onSettingsChanged?.(settings);
    if (settings.enabled) void this.options.engines.load(settings.lists).catch(() => undefined);
  }

  /** Relax (or restore) protection for one site without touching global settings. */
  setSiteException(urlOrSite: string, exception: SiteException | null): void {
    const site = urlOrSite.includes('/') ? siteOf(urlOrSite) : urlOrSite.toLowerCase();
    const siteExceptions = { ...this.settings.siteExceptions };
    const clean = exception && Object.fromEntries(Object.entries(exception).filter(([, v]) => v === true));
    if (clean && Object.keys(clean).length) siteExceptions[site] = clean;
    else delete siteExceptions[site];
    this.setSettings({ ...this.settings, siteExceptions });
  }

  exceptionFor(topLevelUrl: string): SiteException {
    return this.settings.siteExceptions[siteOf(topLevelUrl)] ?? {};
  }

  /**
   * Call when an upgraded https:// navigation fails (TLS or connection error). The host
   * is remembered for this app session and the returned http:// URL can be loaded.
   */
  reportHttpsFailure(url: string): string | undefined {
    if (!url.startsWith('https://')) return undefined;
    this.httpsFailedHosts.add(hostOf(url));
    return 'http://' + url.slice('https://'.length);
  }

  /** True if `url` is an https:// URL this profile upgraded from http:// in the last few minutes. */
  wasUpgraded(url: string): boolean {
    const at = this.recentUpgrades.get(url);
    return at !== undefined && this.now() - at < 5 * 60_000;
  }

  panelState(webContentsId: number, topLevelUrl: string): PanelState {
    const exception = this.exceptionFor(topLevelUrl);
    return {
      enabled: this.settings.enabled,
      preset: this.settings.preset,
      site: siteOf(topLevelUrl),
      exception,
      blockingActive: this.settings.enabled && !exception.disableBlocking && isHttpUrl(topLevelUrl),
      engine: this.options.engines.status(this.settings.lists),
      tab: this.stats.forTab(webContentsId),
    };
  }

  /**
   * Element-hiding CSS and uBO scriptlets for one frame, or null when blocking
   * is off for the page. `dom` (classes, ids, link hrefs seen in the page)
   * selects generic rules; without it, site-specific rules and scriptlets are returned.
   */
  cosmeticsFor(frameUrl: string, topLevelUrl: string, dom?: { classes?: string[]; ids?: string[]; hrefs?: string[] }): { css: string; scripts: string[] } | null {
    const s = this.settings;
    const ex = this.exceptionFor(topLevelUrl || frameUrl);
    if (!s.enabled || !isHttpUrl(frameUrl) || ex.disableBlocking || (ex.disableScriptlets && ex.disableCosmetics)) return null;
    // Generic rules (from the page's classes and ids) are only hiding rules.
    if (dom && ex.disableCosmetics) return null;
    const engines = [this.options.engines.peek(s.lists), this.customCosmeticEngine()].filter((e): e is FiltersEngine => !!e);
    if (!engines.length) return null;
    const hostname = hostOf(frameUrl);
    let css = '';
    const scripts: string[] = [];
    for (const engine of engines) {
      const r = engine.getCosmeticsFilters({
        url: frameUrl,
        hostname,
        domain: siteOf(frameUrl),
        classes: dom?.classes,
        ids: dom?.ids,
        hrefs: dom?.hrefs,
        getBaseRules: !dom,
        getInjectionRules: !dom,
        getExtendedRules: false,
        getRulesFromHostname: !dom,
        getRulesFromDOM: !!dom,
      });
      if (!r.active) continue;
      if (r.styles && !ex.disableCosmetics) css += r.styles + '\n';
      if (!ex.disableScriptlets) scripts.push(...r.scripts);
    }
    return css || scripts.length ? { css, scripts } : null;
  }

  /** The user's own "##" hiding rules, compiled separately from the downloaded lists. */
  private customCosmeticEngine(): FiltersEngine | undefined {
    const text = this.settings.customFilters.trim();
    if (!text.includes('#')) return undefined;
    if (this.customCosmetic?.source !== text) {
      this.customCosmetic = { source: text, engine: FiltersEngine.parse(text, { loadNetworkFilters: false, loadCosmeticFilters: true }) };
    }
    return this.customCosmetic.engine;
  }

  /** Registers this profile's handler on the hub. Returns an unsubscribe function. */
  attachTo(hub: WebRequestHub, sessionKey: string): () => void {
    const handler = this.handler();
    return hub.use({
      name: handler.name,
      onBeforeRequest: (ctx) => (ctx.sessionKey === sessionKey ? handler.onBeforeRequest!(ctx) : undefined),
      onBeforeSendHeaders: (ctx, h) => (ctx.sessionKey === sessionKey ? handler.onBeforeSendHeaders!(ctx, h) : undefined),
      onHeadersReceived: (ctx, h, s) => (ctx.sessionKey === sessionKey ? handler.onHeadersReceived!(ctx, h, s) : undefined),
    });
  }

  handler(): RequestHandler {
    return {
      name: 'privacy',
      onBeforeRequest: (ctx) => this.onBeforeRequest(ctx),
      onBeforeSendHeaders: (ctx, headers) => this.onBeforeSendHeaders(ctx, headers),
      onHeadersReceived: (ctx, headers) => this.onHeadersReceived(ctx, headers),
    };
  }

  private onBeforeRequest(ctx: RequestContext): { cancel: true } | { redirectURL: string } | void {
    const s = this.settings;
    if (!isHttpUrl(ctx.url)) return;
    const exception = this.exceptionFor(ctx.topLevelUrl);

    if (ctx.resourceType === 'mainFrame') {
      if (s.enabled && s.httpsUpgrade && !exception.disableHttpsUpgrade && !this.httpsFailedHosts.has(hostOf(ctx.url))) {
        const upgraded = httpsUpgrade(ctx.url);
        if (upgraded) {
          this.flag(ctx.webContentsId, { upgradedToHttps: true });
          this.recentUpgrades.set(upgraded, this.now());
          if (this.recentUpgrades.size > 100) this.recentUpgrades.delete(this.recentUpgrades.keys().next().value!);
          return { redirectURL: upgraded };
        }
      }
      if (s.enabled && s.stripTrackingParams && !exception.disableBlocking) {
        const cleaned = stripTrackingParams(ctx.url);
        if (cleaned) {
          this.flag(ctx.webContentsId, { trackingParamsRemoved: true });
          return { redirectURL: cleaned };
        }
      }
      if (ctx.webContentsId !== undefined) {
        this.stats.pageStarted(ctx.webContentsId, ctx.url, this.pendingFlags.get(ctx.webContentsId));
        this.pendingFlags.delete(ctx.webContentsId);
      }
      // Pages themselves are never blocked by list rules; only their sub-resources.
      return;
    }

    if (!s.enabled || exception.disableBlocking) return;
    const request = Request.fromRawDetails({ url: ctx.url, sourceUrl: ctx.topLevelUrl, type: ctx.resourceType });

    const custom = this.getCustomEngines();
    if (custom?.allow.match(request).match) return;
    if (custom) {
      const r = custom.block.match(request);
      if (r.match && !r.exception) return this.block(ctx, r.filter?.toString(), r.redirect?.dataUrl);
    }
    const engine = this.options.engines.peek(s.lists);
    if (!engine) return;
    const r = engine.match(request);
    if (r.match && !r.exception) return this.block(ctx, r.filter?.toString(), r.redirect?.dataUrl);
  }

  private block(ctx: RequestContext, filter: string | undefined, redirectDataUrl: string | undefined): { cancel: true } | { redirectURL: string } {
    this.stats.recordBlocked(ctx.webContentsId, {
      url: ctx.url,
      host: hostOf(ctx.url),
      resourceType: ctx.resourceType,
      filter,
      at: this.now(),
      kind: redirectDataUrl ? 'redirected' : 'blocked',
    });
    // Redirecting to a neutral stub (e.g. an empty script) keeps pages that expect the resource working.
    return redirectDataUrl ? { redirectURL: redirectDataUrl } : { cancel: true };
  }

  private onBeforeSendHeaders(ctx: RequestContext, headers: Record<string, string>): Record<string, string> | void {
    const s = this.settings;
    if (!s.enabled || !isHttpUrl(ctx.url)) return;
    if (s.sendGlobalPrivacyControl && !findHeaderKey(headers, 'Sec-GPC')) headers['Sec-GPC'] = '1';
    if (this.shouldStripCookies(ctx) && deleteHeader(headers, 'Cookie')) this.stats.recordCookieStripped(ctx.webContentsId);
    return headers;
  }

  private onHeadersReceived(ctx: RequestContext, headers: Record<string, string[]>): Record<string, string[]> | void {
    if (!this.shouldStripCookies(ctx)) return;
    if (deleteHeader(headers, 'Set-Cookie')) this.stats.recordCookieStripped(ctx.webContentsId);
    return headers;
  }

  private shouldStripCookies(ctx: RequestContext): boolean {
    const s = this.settings;
    if (!s.enabled || !s.blockThirdPartyCookies || ctx.resourceType === 'mainFrame') return false;
    if (!isHttpUrl(ctx.topLevelUrl)) return false;
    const top = siteOf(ctx.topLevelUrl);
    if (!top || top === siteOf(ctx.url)) return false;
    return !this.settings.siteExceptions[top]?.allowThirdPartyCookies;
  }

  /**
   * The engine only reports an exception when a blocking rule also matched, so user
   * "@@" allow rules are compiled into a separate engine (with "@@" removed) where a
   * match means "allow", letting them override the downloaded lists.
   */
  private getCustomEngines(): { block: FiltersEngine; allow: FiltersEngine } | undefined {
    const text = this.settings.customFilters.trim();
    if (!text) return undefined;
    if (text !== this.customEngineSource) {
      this.customEngineSource = text;
      const lines = text.split(/\r?\n/).map((l) => l.trim());
      const allow = lines.filter((l) => l.startsWith('@@')).map((l) => l.slice(2));
      const config = { loadCosmeticFilters: false };
      this.customEngines = {
        block: FiltersEngine.parse(lines.filter((l) => !l.startsWith('@@')).join('\n'), config),
        allow: FiltersEngine.parse(allow.join('\n'), config),
      };
    }
    return this.customEngines;
  }

  private flag(id: number | undefined, flags: { upgradedToHttps?: boolean; trackingParamsRemoved?: boolean }): void {
    if (id === undefined) return;
    this.pendingFlags.set(id, { ...this.pendingFlags.get(id), ...flags });
  }
}
