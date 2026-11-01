# Module breakdown and plug-in contract

AETHER is a modular monolith: one Electron app, one process tree, one SQLite file, with features in workspace packages behind `@aether/plugin-api`. No backend server is needed for browsing.

## Packages

| Package | Owner | Responsibility | Depends on |
|---|---|---|---|
| `@aether/plugin-api` | shell | Types-only contract between the shell and feature modules | nothing |
| `@aether/storage` | shell | SQLite schema, forward-only migrations, repositories (profiles, history, bookmarks, downloads, workspaces, window sessions, permissions, settings, module KV) | plugin-api, node:sqlite |
| `@aether/omnibox` | shell | Address-bar input to URL/search/bang; display formatting | nothing |
| `@aether/desktop` | shell | Electron app: main, preload, React UI, e2e tests | all of the above |
| `@aether/web-request-hub` | privacy | Single owner of `session.webRequest` listeners; ordered, fail-open handlers | nothing |
| `@aether/privacy` | privacy | Ad/tracker blocking (Ghostery adblocker engine), cookie stripping, HTTPS upgrade, GPC | hub, tldts |
| `@aether/focus` | privacy | Focus modes, rules, interventions, Pomodoro | hub, tldts |
| `@aether/activity` | privacy | Local time tracking and reports | tldts |
| `@aether/protection-module` | privacy | Main-process module `aether.protection` wiring the four above | all four |
| research / writing packages | research | Research sidebar, citations, notes, paper writer | plugin-api |

## Writing a module

Main process (`apps/desktop/src/main/modules.ts`):

```ts
import type { AetherMainModule } from '@aether/plugin-api';

export const exampleModule: AetherMainModule = {
  id: 'example',
  activate(host) {
    host.storage.migrate([{ version: 1, up: 'CREATE TABLE example_notes (id INTEGER PRIMARY KEY, url TEXT, body TEXT)' }]);
    host.ipc.handle('save', (payload, ctx) => {
      // validate payload; ctx = { windowId, profileId, isPrivate }
    });
    host.events.on('tabNavigated', (t) => host.log.info('navigated', t.url));
    host.navigation.addInterceptor((req) => (req.url.includes('example.invalid') ? { action: 'block', reason: 'Example rule' } : { action: 'allow' }));
    host.sessions.onSessionCreated((session, ctx) => { /* attach request hub handlers */ });
    host.internalPages.register('example', () => ({ html: '<h1>Hi</h1>' }));
  },
};
```

Renderer (`apps/desktop/src/renderer/modules.ts`):

```ts
import type { AetherRendererModule } from '@aether/plugin-api';
export const exampleUi: AetherRendererModule = {
  id: 'example',
  panels: [{ id: 'main', title: 'Example', icon: '✎', component: ExamplePanel }],
};
// ExamplePanel({ api }) -> api.invoke('save', {...}), api.on('event', fn), api.openUrl(url), api.activeTab
```

## Host surface (summary of `MainHost`)

| Member | Purpose |
|---|---|
| `storage` / `db` | Shared SQLite (`exec`, `prepare().run/get/all`), per-module migrations, per-module/per-profile JSON KV |
| `sessions.onSessionCreated` | Every profile and private session, including ones created before activation |
| `navigation.addInterceptor` | Allow / block / redirect top-level navigations the shell starts or observes (omnibox, links, popups, restore) |
| `internalPages.register` | Serve `aether://<name>/…` (unprivileged, script-free) |
| `events.on` | `windowFocusChanged`, `windowMinimized`, `activeTabChanged`, `tabNavigated` (`inPage`), `tabAudible`, `tabClosed`, `windowClosed`, `tabLoadFailed`, `profileDeleted`, `systemSuspended`, `systemResumed`, `appWillQuit` |
| `tabs` | `getActive`, `get`, `list`, `open`, `navigate`, `fromWebContentsId`, `getPageContent` (text, meta tags, DOIs, selection, read in an isolated world) |
| `profiles` | `list`, `get` |
| `ipc.handle` / `ipc.emit` | Privileged UI calls `aether.module.invoke(moduleId, method, payload)` and module events |
| `system.getIdleSeconds`, `net.fetch`, `notifications.show`, `log`, `dataDir` | Utilities |

Failure isolation: a throwing `activate`, listener or interceptor is logged and skipped; interceptors fail open.

## Rules for modules

1. Never register `session.webRequest` listeners directly; use the hub (one listener per event per session is an Electron limit).
2. Tables are prefixed with the module's name (`research_`, `activity_`...). Delete a profile's rows on `profileDeleted`.
3. Validate every IPC payload; take identity from `ctx`, not from the payload.
4. Do not inject scripts into pages' main world. Read-only extraction uses `tabs.getPageContent` (isolated world).
5. Private windows (`isPrivate`) must not be recorded or persisted.
