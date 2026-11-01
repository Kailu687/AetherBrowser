import { ActivityTracker, SqlActivityStore, buildReport, defaultActivitySettings, handleActivityPage, rangeFor, recordFocusEvents, type ActivitySettings } from '@aether/activity';
import { FocusEngine, defaultFocusSettings, handleInterventionPage, type FocusMode, type FocusSettings, type InterventionChoice, type PersistedFocusState } from '@aether/focus';
import type { AetherMainModule, MainHost, TabContext } from '@aether/plugin-api';
import {
  FilterEngineManager,
  PrivacyProtection,
  applyPreset,
  defaultPrivacySettings,
  exportSettings,
  importSettings,
  sanitizeSettings,
  type BrowserRequestLogEntry,
  type PrivacyPreset,
  type PrivacySettings,
} from '@aether/privacy';
import { WebRequestHub, type SessionLike } from '@aether/web-request-hub';
import { fileEngineCache } from './engine-cache.js';
import { bool, num, obj, oneOf, optNum, str } from './validate.js';

export const MODULE_ID = 'aether.protection';
const TABLE_PREFIX = 'aether_protection_';

/** Chromium net errors after which an upgraded https:// page is retried over http://. */
const HTTPS_FALLBACK_ERRORS = new Set([-7, -100, -101, -102, -104, -105, -106, -107, -109, -113, -117, -118, -137, -138]);
const isCertError = (code: number) => code <= -200 && code > -300;

export interface ProtectionModuleOptions {
  /** How often to tick the activity tracker and focus schedules. Default 15 s. */
  tickMs?: number;
}

export interface ProtectionModule extends AetherMainModule {
  hub: WebRequestHub;
}

type IpcCtx = { windowId: number; profileId: string; isPrivate: boolean };

/**
 * Ad/tracker blocking, focus rules and local time tracking for the AETHER shell.
 * Heavy work is lazy: compiled filter lists load from disk in the background, and
 * the per-request cost is one hash-based filter lookup.
 */
export function createProtectionModule(options: ProtectionModuleOptions = {}): ProtectionModule {
  let warnSink: ((m: string, d?: unknown) => void) | undefined;
  const hub = new WebRequestHub({ onError: (h, e) => warnSink?.(`request handler "${h}" failed`, e) });
  let cleanup: (() => void) | undefined;

  return {
    id: MODULE_ID,
    hub,
    deactivate: () => cleanup?.(),
    activate(host: MainHost) {
      const warn = (m: string, d?: unknown) => host.log.warn(m, d);
      warnSink = warn;
      const kv = host.storage.kv;
      const browserRequests: BrowserRequestLogEntry[] = [];
      const engines = new FilterEngineManager({
        fetch: (url) => host.net.fetch(url),
        cache: fileEngineCache(host.dataDir),
        onBrowserRequest: (e) => {
          browserRequests.push(e);
          if (browserRequests.length > 200) browserRequests.shift();
        },
      });

      // ---- tab <-> webContents mapping (webRequest only knows webContentsId) ----------
      const tabToWc = new Map<number, number>();
      const wcToTab = new Map<number, TabContext>();
      hub.use({
        name: 'tab-map',
        onBeforeRequest: (ctx) => {
          if (ctx.resourceType !== 'mainFrame' || ctx.webContentsId === undefined) return;
          const tab = host.tabs.fromWebContentsId(ctx.webContentsId);
          if (!tab) return;
          tabToWc.set(tab.tabId, ctx.webContentsId);
          wcToTab.set(ctx.webContentsId, tab);
        },
      });

      // ---- privacy: one protection per session partition ------------------------------
      const bySessionKey = new Map<string, { protection: PrivacyProtection; profileId: string; isPrivate: boolean }>();
      const byProfile = new Map<string, PrivacyProtection>();
      const privateByProfile = new Map<string, PrivacyProtection>();
      const lastEmit = new Map<number, ReturnType<typeof setTimeout>>();

      const loadPrivacy = (profileId: string): PrivacySettings => {
        const raw = kv.get<Record<string, unknown>>('privacy-settings', profileId);
        return raw ? sanitizeSettings(raw) : defaultPrivacySettings();
      };

      host.sessions.onSessionCreated((session, sctx) => {
        const key = sctx.partition;
        if (bySessionKey.has(key)) return;
        const protection = new PrivacyProtection({
          engines,
          settings: loadPrivacy(sctx.profileId),
          // Private windows start from the profile's settings but never write changes back.
          onSettingsChanged: sctx.isPrivate ? undefined : (s) => kv.set('privacy-settings', s, sctx.profileId),
        });
        bySessionKey.set(key, { protection, profileId: sctx.profileId, isPrivate: sctx.isPrivate });
        (sctx.isPrivate ? privateByProfile : byProfile).set(sctx.profileId, protection);
        protection.stats.onChange((wcId) => {
          // Coalesce bursts of blocked requests into one UI update per tab.
          if (lastEmit.has(wcId)) return;
          lastEmit.set(
            wcId,
            setTimeout(() => {
              lastEmit.delete(wcId);
              const tab = wcToTab.get(wcId);
              if (tab) host.ipc.emit('privacy-changed', { tabId: tab.tabId, blocked: protection.stats.forTab(wcId)?.blocked ?? 0 }, tab.windowId);
            }, 400),
          );
        });
        try {
          hub.attach(session as unknown as SessionLike, key);
        } catch (e) {
          warn('could not attach to session', e);
        }
        protection.attachTo(hub, key);
        const s = protection.getSettings();
        if (s.enabled) void engines.load(s.lists).catch((e) => warn('filter lists failed to load', e));
      });

      // ---- cosmetic filtering: element hiding + scriptlets at document start ------------
      host.content?.onFrameStart((req) => {
        const entry = bySessionKey.get(req.partition);
        if (!entry) return null;
        return entry.protection.cosmeticsFor(req.url, req.topLevelUrl, req.dom);
      });

      const protectionFor = (ctx: IpcCtx): PrivacyProtection => {
        const p = (ctx.isPrivate ? privateByProfile.get(ctx.profileId) : undefined) ?? byProfile.get(ctx.profileId);
        if (!p) throw new Error('Privacy protection is not ready for this window yet.');
        return p;
      };

      host.events.on('tabLoadFailed', (e) => {
        if (!(HTTPS_FALLBACK_ERRORS.has(e.code) || isCertError(e.code))) return;
        for (const { protection } of bySessionKey.values()) {
          if (!protection.wasUpgraded(e.failedUrl)) continue;
          const http = protection.reportHttpsFailure(e.failedUrl);
          if (http) host.tabs.navigate(e.tabId, http);
          return;
        }
      });

      // ---- activity tracking -------------------------------------------------------------
      const store = new SqlActivityStore(host.storage.db, { tablePrefix: TABLE_PREFIX });
      const tracker = new ActivityTracker({
        store,
        settings: { ...defaultActivitySettings(), ...(kv.get<Partial<ActivitySettings>>('activity-settings') ?? {}) },
        getIdleSeconds: () => host.system.getIdleSeconds(),
        onBudgetReminder: (r) =>
          host.notifications.show({
            title: r.percent >= 100 ? 'Daily time budget reached' : 'Approaching your daily budget',
            body: `${r.usedMinutes} of ${r.budget.dailyMinutes} min used today.`,
            silent: true,
          }),
      });
      const persistActivity = () => kv.set('activity-settings', tracker.getSettings());

      // ---- focus ---------------------------------------------------------------------------
      const focus = new FocusEngine({
        settings: { ...defaultFocusSettings(), ...(kv.get<Partial<FocusSettings>>('focus-settings') ?? {}) },
        state: kv.get<PersistedFocusState>('focus-state'),
        getCurrentUrl: (wcId) => wcToTab.get(wcId)?.url ?? host.tabs.fromWebContentsId(wcId)?.url,
      });
      let stateTimer: ReturnType<typeof setTimeout> | undefined;
      focus.on('state-changed', (s) => {
        clearTimeout(stateTimer);
        stateTimer = setTimeout(() => kv.set('focus-state', s), 250);
      });
      focus.on('session-changed', (st) => host.ipc.emit('focus-changed', st));
      focus.on('notify', (n) => host.notifications.show({ ...n, silent: true }));
      recordFocusEvents(focus, store, () => tracker.isRecording());

      // Top-level navigations the shell starts (address bar, links, popups, restores).
      host.navigation.addInterceptor((req) => {
        const d = focus.evaluateNavigation(req.url, { profileId: req.profileId, isPrivate: req.isPrivate, previousUrl: req.tab?.url });
        return d.kind === 'intervene' ? { action: 'redirect', url: d.redirectUrl } : { action: 'allow' };
      });
      // Everything else that reaches the network: server redirects, form GETs, embeds.
      hub.use(
        {
          name: 'focus',
          onBeforeRequest: (ctx) => {
            if ((ctx.resourceType !== 'mainFrame' && ctx.resourceType !== 'subFrame') || ctx.method !== 'GET') return;
            const session = bySessionKey.get(ctx.sessionKey);
            const tab = ctx.webContentsId !== undefined ? host.tabs.fromWebContentsId(ctx.webContentsId) : null;
            const d = focus.evaluateNavigation(
              ctx.url,
              { webContentsId: ctx.webContentsId, profileId: session?.profileId ?? ctx.sessionKey, isPrivate: session?.isPrivate },
              ctx.resourceType === 'mainFrame' ? 'pages' : 'embedded',
            );
            if (d.kind === 'cancel') return { cancel: true };
            if (d.kind !== 'intervene') return;
            // Navigating the tab is more reliable than redirecting a network request to aether://.
            if (tab) {
              host.tabs.navigate(tab.tabId, d.redirectUrl);
              return { cancel: true };
            }
            return { redirectURL: d.redirectUrl };
          },
        },
        { first: true },
      );

      const tick = setInterval(() => {
        try {
          tracker.tick();
          focus.tick();
        } catch (e) {
          warn('tick failed', e);
        }
      }, options.tickMs ?? 15_000);
      (tick as { unref?: () => void }).unref?.();

      // ---- shell events ----------------------------------------------------------------------
      host.events.on('windowFocusChanged', (e) => tracker.windowFocusChanged(e));
      host.events.on('windowMinimized', (e) => tracker.windowMinimized(e));
      host.events.on('activeTabChanged', (e) => tracker.activeTabChanged(e));
      host.events.on('tabNavigated', (e) => {
        tracker.tabNavigated(e);
        if (!e.inPage) return;
        const d = focus.evaluateNavigation(e.url, { profileId: e.profileId, isPrivate: e.isPrivate });
        if (d.kind === 'intervene') host.tabs.navigate(e.tabId, d.redirectUrl);
      });
      host.events.on('tabAudible', (e) => {
        tracker.tabNavigated(e);
        tracker.tabAudible(e);
      });
      host.events.on('tabClosed', (e) => {
        tracker.tabClosed(e);
        const wc = tabToWc.get(e.tabId);
        if (wc !== undefined) {
          tabToWc.delete(e.tabId);
          wcToTab.delete(wc);
          for (const { protection } of bySessionKey.values()) protection.stats.tabClosed(wc);
        }
      });
      host.events.on('windowClosed', (e) => tracker.windowClosed(e));
      host.events.on('systemSuspended', () => tracker.systemSuspended());
      host.events.on('systemResumed', () => tracker.systemResumed());
      host.events.on('profileDeleted', (e) => {
        store.deleteProfile(e.profileId);
        kv.delete('privacy-settings', e.profileId);
      });
      const flushAll = () => {
        tracker.flush();
        clearTimeout(stateTimer);
        kv.set('focus-state', focus.exportState());
      };
      host.events.on('appWillQuit', flushAll);
      cleanup = () => {
        clearInterval(tick);
        flushAll();
        focus.dispose();
      };

      // ---- internal pages ----------------------------------------------------------------------
      host.internalPages.register('intervention', (url) => handleInterventionPage(focus, url));
      host.internalPages.register('activity', (url) => handleActivityPage(url, { store, tracker, profileNames: () => Object.fromEntries(host.profiles.list().map((p) => [p.id, p.name])) }));

      // ---- privileged IPC (AETHER's own UI) ------------------------------------------------------
      const h = (method: string, fn: (p: Record<string, unknown>, ctx: IpcCtx) => unknown) =>
        host.ipc.handle(method, (payload, ctx) => fn(obj(payload ?? {}), ctx));
      const tabFor = (p: Record<string, unknown>, ctx: IpcCtx): TabContext | null =>
        p.tabId === undefined ? host.tabs.getActive(ctx.windowId) : host.tabs.get(num(p.tabId));

      h('privacy.panel', (p, ctx) => {
        const tab = tabFor(p, ctx);
        const wc = tab ? tabToWc.get(tab.tabId) : undefined;
        return { ...protectionFor(ctx).panelState(wc ?? -1, tab?.url ?? ''), tabId: tab?.tabId ?? null, isPrivate: ctx.isPrivate };
      });
      h('privacy.getSettings', (_p, ctx) => protectionFor(ctx).getSettings());
      h('privacy.setPreset', (p, ctx) => {
        const pr = protectionFor(ctx);
        pr.setSettings(applyPreset(pr.getSettings(), oneOf<PrivacyPreset>(p.preset, ['balanced', 'strict', 'custom'])));
        return pr.getSettings();
      });
      h('privacy.setSettings', (p, ctx) => {
        const pr = protectionFor(ctx);
        pr.setSettings(sanitizeSettings(obj(p.settings)));
        return pr.getSettings();
      });
      h('privacy.setEnabled', (p, ctx) => {
        const pr = protectionFor(ctx);
        pr.setSettings({ ...pr.getSettings(), enabled: bool(p.enabled) });
        return pr.getSettings();
      });
      h('privacy.setSiteException', (p, ctx) => {
        const pr = protectionFor(ctx);
        const url = p.url === undefined ? (tabFor(p, ctx)?.url ?? '') : str(p.url);
        const ex = p.exception === null ? null : obj(p.exception);
        pr.setSiteException(url, ex && { disableBlocking: ex.disableBlocking === true, allowThirdPartyCookies: ex.allowThirdPartyCookies === true, disableHttpsUpgrade: ex.disableHttpsUpgrade === true, disableScriptlets: ex.disableScriptlets === true, disableCosmetics: ex.disableCosmetics === true });
        return pr.exceptionFor(url);
      });
      h('privacy.export', (_p, ctx) => exportSettings(protectionFor(ctx).getSettings()));
      h('privacy.import', (p, ctx) => {
        const pr = protectionFor(ctx);
        pr.setSettings(importSettings(str(p.json, 2_000_000)));
        return pr.getSettings();
      });
      h('privacy.refreshLists', async (_p, ctx) => engines.refresh(protectionFor(ctx).getSettings().lists));
      h('privacy.browserRequests', () => [...browserRequests]);

      h('focus.status', () => focus.status());
      h('focus.start', (p) =>
        focus.startSession({
          mode: oneOf<FocusMode>(p.mode, ['deep-work', 'study', 'research', 'relaxed', 'custom']),
          goal: p.goal === undefined ? '' : str(p.goal, 200),
          plannedMinutes: optNum(p.plannedMinutes, 1, 600),
          timer: p.timer === false ? false : p.timer === undefined ? undefined : timerConfig(obj(p.timer)),
        }),
      );
      h('focus.pause', () => (focus.pauseSession(), focus.status()));
      h('focus.resume', () => (focus.resumeSession(), focus.status()));
      h('focus.end', () => focus.endSession() ?? null);
      h('focus.skipPhase', () => (focus.skipPhase(), focus.status()));
      h('focus.startNextPhase', () => (focus.startNextPhase(), focus.status()));
      h('focus.getSettings', () => focus.getSettings());
      h('focus.setSettings', (p) => {
        focus.setSettings({ ...defaultFocusSettings(), ...(obj(p.settings) as Partial<FocusSettings>) });
        kv.set('focus-settings', focus.getSettings());
        return focus.getSettings();
      });
      h('focus.resolveIntervention', (p) =>
        focus.resolveIntervention(str(p.id), oneOf<InterventionChoice>(p.choice, ['back', 'continue', 'allow', 'end']), optNum(p.minutes, 1, 240)),
      );

      h('activity.getSettings', () => tracker.getSettings());
      h('activity.setSettings', (p) => {
        tracker.setSettings({ ...defaultActivitySettings(), ...(obj(p.settings) as Partial<ActivitySettings>) });
        persistActivity();
        return tracker.getSettings();
      });
      h('activity.pause', (p) => (tracker.pause(optNum(p.minutes, 1, 24 * 60)), persistActivity(), tracker.getSettings()));
      h('activity.resume', () => (tracker.resume(), persistActivity(), tracker.getSettings()));
      h('activity.report', (p) => {
        tracker.flush();
        return buildReport(store, rangeFor(oneOf(p.range ?? 'today', ['today', 'week'] as const), Date.now()), p.profileId === undefined ? undefined : str(p.profileId));
      });
      h('activity.current', () => ({ recording: tracker.isRecording(), targets: tracker.currentTargets() }));
      h('activity.deleteAll', () => (store.deleteAll(), true));
      h('activity.deleteRange', (p) => (store.deleteRange(num(p.from), num(p.to)), true));
      h('activity.deleteDomain', (p) => (store.deleteDomain(str(p.domain, 253).toLowerCase()), true));
    },
  };
}

function timerConfig(t: Record<string, unknown>) {
  return {
    workMinutes: optNum(t.workMinutes, 1, 240),
    shortBreakMinutes: optNum(t.shortBreakMinutes, 1, 60),
    longBreakMinutes: optNum(t.longBreakMinutes, 1, 120),
    longBreakEvery: optNum(t.longBreakEvery, 0, 12),
    cycles: optNum(t.cycles, 0, 50),
    autoStartBreaks: t.autoStartBreaks === undefined ? undefined : bool(t.autoStartBreaks),
    autoStartWork: t.autoStartWork === undefined ? undefined : bool(t.autoStartWork),
  };
}
