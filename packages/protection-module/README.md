# Privacy, focus and time tracking

Five workspace packages, all TypeScript consumed as source, no Electron import at runtime:

| Package | What it does |
|---|---|
| `@aether/web-request-hub` | Owns `session.webRequest` listeners. Electron keeps only one listener per event per session, so every feature registers a handler here instead. Handlers fail open: a bug never hangs a page. |
| `@aether/privacy` | Ad and tracker blocking on `@ghostery/adblocker` (MPL-2.0), Balanced / Strict / Custom presets, per-site exceptions, third-party cookie stripping, HTTPS upgrade with fallback, click-tracking parameter removal, Global Privacy Control header, per-tab blocked-request counts, settings import/export. |
| `@aether/focus` | Focus modes (Deep Work, Study, Research, Relaxed, Custom), domain and URL-path rules, intervention screen, strictness levels, Pomodoro timer, schedules, crash-safe session state. |
| `@aether/activity` | Local time tracking with idle detection, SQLite store, daily and weekly reports, budgets, CSV/JSON export, script-free dashboard page. |
| `@aether/protection-module` | The main-process module (`id: aether.protection`), typed against `@aether/plugin-api`. |
| `@aether/protection-ui` | Sidebar panels: Focus (start, timer, rules), Privacy (per-page blocked list, site switch, presets, list status) and Time (today, exclusions, retention, delete). |

## Shell integration

```ts
// apps/desktop/src/main/modules.ts
import { createProtectionModule } from '@aether/protection-module';
export const MAIN_MODULES = [createProtectionModule()];

// apps/desktop/src/renderer/modules.ts
import { protectionRendererModule } from '@aether/protection-ui';
export const RENDERER_MODULES = [protectionRendererModule];
```

What it uses from `MainHost`:

- `sessions.onSessionCreated` for every partition (private ones included); the hub is keyed by partition.
- `navigation.addInterceptor` for address-bar, link, popup and restore navigations; the request hub catches server redirects, form GETs and embedded frames. A blocked main-frame request is cancelled and the tab is sent to the intervention page with `tabs.navigate`.
- `events`: activity tracking from focus/tab/audio/window events; `tabNavigated.inPage` for single-page apps (YouTube Shorts); `tabLoadFailed` for the automatic http fallback after a failed HTTPS upgrade; `profileDeleted` removes that profile's activity rows and privacy settings; `appWillQuit` flushes state.
- `storage.kv` for settings (privacy settings per profile), `storage.db` for activity tables prefixed `aether_protection_`, `dataDir` for the compiled filter-list cache (atomic file writes).
- `net.fetch` for list downloads, `notifications.show` (silent) for session and budget notices, `ipc.handle`/`ipc.emit` (`privacy-changed`, `focus-changed`).

IPC methods take the profile from the shell's context and an optional `tabId` (default: the window's active tab): `privacy.panel | getSettings | setPreset | setSettings | setEnabled | setSiteException | export | import | refreshLists | browserRequests`, `focus.status | start | pause | resume | end | skipPhase | startNextPhase | getSettings | setSettings | resolveIntervention`, `activity.getSettings | setSettings | pause | resume | report | current | deleteAll | deleteRange | deleteDomain`. Payloads are validated; bad input throws.

## Behaviour and limits

**Blocking.** Only network requests are filtered. Cosmetic filtering (hiding page elements) needs script injection into pages and is not shipped yet, so some empty ad slots remain. Top-level pages are never blocked by list rules. The tracker indicator counts only requests this code actually cancelled or redirected. This is not uBlock Origin and does not claim its coverage.

**Filter lists** are downloaded at runtime from their publishers (EasyList, EasyPrivacy, uBlock filters) with a GitHub mirror as fallback, compiled once, and cached in SQLite; startup reads the cache and refreshes in the background every 4 days. These lists are GPL-3.0 or GPL-3.0/CC-BY-SA-3.0 dual-licensed; AETHER does not bundle them, which keeps its own licence choice open. Every download is listed in `privacy.browserRequests`. If lists cannot be downloaded the panel reports `unavailable` instead of pretending protection is on.

**Presets.** Balanced: ads + trackers, tracking-parameter removal, GPC. Strict adds annoyance lists, third-party cookie stripping and HTTPS upgrade (local and IP hosts are never upgraded). Any deviation becomes Custom. Third-party cookie stripping can break embedded sign-ins; the per-site "allow third-party cookies" exception fixes that for one site.

**Focus.** The most specific rule wins (`youtube.com/shorts` beats `youtube.com`); an allow wins a tie. Rules run on main-frame requests and on in-page navigations; rules with `scope: 'embedded'` cancel matching iframes. Strictness: gentle offers everything at once; balanced asks for a 5 s pause before continuing or allowing; strict never continues to blocked sites and offers only 5 minute allowances after 15 s. Ending the session is always available, so this is a speed bump, not a lock. Rules relax during Pomodoro breaks and while a session is paused. Session state, timer and allowances are persisted and restored after a crash or restart.

**Time tracking.** Active = window focused + tab in front + input within the idle threshold (default 60 s), measured. Passive = tab in front after input stops, capped at 10 min, inferred. Media = audible tab not being used, inferred. When idle is detected the last minute is corrected retroactively, so walking away does not count as active. Only the registrable domain and category are stored; no URLs, titles, keystrokes, form contents or screenshots. Private windows, excluded profiles and excluded domains are never recorded. Open segments are checkpointed every minute, so a crash loses at most a minute. Records past the retention limit (default 90 days) are deleted automatically.

## Tests

`npm test` runs 98 unit and integration tests (hub, blocking with fixture lists, engine cache, settings import, rules, timer, focus engine, intervention page, tracker, reports, SQLite store, and the module against a fake host with real node:sqlite). `AETHER_NETWORK_TESTS=1 npm test` also downloads the real lists and checks that doubleclick and Google Analytics are blocked while first-party scripts are not.

Not yet verified: running inside Electron itself (waiting for the shell), performance on large real sessions, and behaviour on a representative site set.
