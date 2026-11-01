# AETHER handoff

Last updated: 2026-10-31, version 0.3.2. Keep this file current with every change; it is the briefing for whoever (or whichever AI tool) continues the work.

## What AETHER is

AETHER is a privacy-first desktop browser for everyday users and engineers, built by Kailash. It is local-first: no accounts and no cloud. Its signature ideas are:

- **Profiles** with truly isolated storage.
- **Workspaces**, so you can switch context (for example VLSI internship vs aircraft startup) without losing tabs, notes or reading positions.
- **"Keep this window?"** when you close a window, with restore on reopen.
- **Strong ad blocking** on by default.
- **Engineer tools:** a unit-aware address-bar calculator, datasheet shortcuts, research notes and citations, and a paper writer.
- **Themes**, with AETHER as the default and Aviation (glass cockpit) as a signature theme.

Standing rules from Kailash:

- Never bypass site sign-in or account security.
- Never help evade AI-writing detectors; the writer is for sourced, defensible papers.
- Don't claim absolute privacy.
- Don't label prototypes as finished.
- Keep it lightweight and crash-proof.

## Where things are

- Source of truth on the PC: `C:\Users\Kailash A\Desktop\Projects\Aether Browser`. There is no GitHub repo yet.
- Installers: `releases\AETHER-Setup-<version>.exe`, plus `releases\latest.json` (the manifest that the in-app updater reads).

## Run, test and build (Windows, Node 22+)

```
npm install                      # once, and whenever package.json files change
npm run dev                      # dev mode with hot reload
npm test                         # unit tests (vitest, ~250 tests)
npm run test:e2e -w @aether/desktop   # end-to-end: launches the real app (16 scenarios)
npm run dist:win -w @aether/desktop   # installer -> apps\desktop\release\AETHER-Setup-<v>.exe + latest.json
```

**Releasing a version:**

1. Bump `apps/desktop/package.json` `version`.
2. Add a CHANGELOG.md entry.
3. Run `dist:win`.
4. Copy `AETHER-Setup-<v>.exe` and `latest.json` into `releases\`.

The installed app then offers "Restart and update". On Linux, `dist:win` needs `wine64` and `wine32:i386`.

## Architecture

- **Stack:** Electron 38 (Chromium 140) with WebContentsView per tab; React 19 + TypeScript + Vite UI; esbuild for main/preload; SQLite through `node:sqlite` (`DatabaseSync`); npm workspaces; electron-builder NSIS.
- **`apps/desktop`**, the shell:
  - `src/main`: `shell.ts` (app state), `window.ts` (windows, tabs, split view, persistence, shortcuts), `tab.ts`, `sessions.ts` (one partition per profile, private windows in memory), `ipc.ts` (the only privileged IPC, with sender and payload validation in `validate.ts`), `module-host.ts` (runs feature modules and isolates their failures), `internal-pages.ts` (`aether://` pages, script-free), `passwords.ts` (store, fill, save offers), `downloads.ts`, `updater.ts`, `reader.ts` (Readability in an isolated world, output sanitised), `extensions.ts`.
  - `src/preload/ui.ts`: the allowlisted `window.aether` bridge, UI only.
  - `src/preload/content.ts`: the web-page preload. It is sandboxed and isolated, exposes nothing, and requests cosmetic filters.
  - `src/renderer`: the React UI (tab strip with groups, toolbar/omnibox, bookmarks bar, sidebar panels, command palette, settings, themes).
  - `src/renderer/icons`: icon sets. `Icon` draws the active theme's set (for example `flight-deck` for Aviation) and falls back to the base paths in `Icon.tsx`. To add a themed icon set, add a set file, register it in `icons/index.ts`, and set `iconSet` on the theme in `shared/themes.ts`.
  - `src/shared`: types and `themes.ts`.
- **`packages/`**, consumed as TS source:
  - `plugin-api` is the types-only contract for modules: `AetherMainModule.activate(host: MainHost)`, renderer panels, events, navigation interceptors, `content.onFrameStart` and secrets.
  - Shell-owned packages: `storage` (schema and migrations, `AetherStore`, `CredentialStore`) and `omnibox` (bangs, URL/search resolution, `quickCalc`).
  - Privacy: `web-request-hub` (the only owner of `session.webRequest`), `privacy` (Ghostery adblocker engine, lists, cosmetic filters), `protection-module` and `protection-ui`, `focus`, `activity`.
  - Research: `research-core`, `citations`, `sources`, `notebook`, `annotations`, `pdf-viewer`, `paper-editor`, `calculators`, `ai`, `research-module`.
- **Docs:** `docs/architecture.md`, `docs/modules.md`, `docs/data-model.md`, `docs/threat-model.md` (security controls and the honest list of limits) and `docs/licensing.md`.

**Security invariants (do not break):**

- Web views: `sandbox`, `contextIsolation`, no node.
- The UI session can't reach the network.
- Every IPC handler validates its sender and payload.
- Passwords are encrypted with Electron `safeStorage` and are never stored if encryption is unavailable.
- Internal pages have no scripts.

## Current state (0.3.1)

**Working and tested:**

- Everything in CHANGELOG 0.1.0 to 0.3.1.
- Tests: 259 unit tests and 19 end-to-end tests pass on Linux CI.
- The Windows installer builds, and the packaged exe boots and activates its modules (checked under Wine).

**Not verified yet:** a full manual run on real Windows (install, shortcut, update flow); live Google sign-in; pdf.js page rendering by hand.

**Not implemented yet:**

- Chrome Web Store installs, and extension toolbar buttons and popups (unpacked extensions load, but only partly).
- Password master lock.
- Bookmark editing UI (rename or move; delete works).
- Picker for Web Serial, USB and HID devices.
- Mark-of-the-Web on downloads.
- Safe Browsing.
- Code signing (Windows SmartScreen will warn on first install).

## Recent fixes (0.3.1)

- **YouTube, part 2 (open).** On 0.3.1 the scriptlet exceptions are gone (0 against 10). With blocking on, the watch page still renders only the player: innerText is 11 characters against 1967 with blocking off, there are 0 related videos against 20, and the tab is very slow (a simple evaluate took 4.5 s against 6 ms). YouTube gets these scriptlets: setConstant ×6, trustedJsonEditXhrRequest ×4, trustedReplaceFetchResponse ×4, jsonPrune ×3, jsonPruneFetchResponse ×3, trustedPreventDomBypass ×3, trustedReplaceXhrResponse ×2, adjustSetTimeout, removeNodeText and preventXhr. To bisect on the PC, use `AETHER_SKIP_SCRIPTLETS=<regex on function name>` or the new per-site `disableScriptlets` and `disableCosmetics` switches.
- **YouTube, part 1 (fixed in 0.3.1).** Diagnosed on Kailash's PC over CDP: with blocking on there were 10 exceptions from scriptlets, starting with `Identifier 'JSONPath' has already been declared` and followed by `reading 'factory'` and `reading 'get'` errors in YouTube's player. With blocking off it played fine. The cause was that `src/preload/content.ts` ran every scriptlet in the shared global scope. Each one now goes through `isolateScriptlet` (`src/preload/scriptlets.ts`, with a unit test). A real-YouTube recheck on Windows is pending. The cloud dev machine can't reach youtube.com, so YouTube must be tested on the PC.
- **Theme button and ⋮ menu.** Both are native menus, handled by the `app:menu` IPC in `src/main/ipc.ts`.
- **Sidebar redesign.** Reusable CSS: `.action-bar`, `.seg`, and the `EmptyState` component.

## Next steps (in order)

1. Typical-browser polish:
   - Extension toolbar buttons and popups (`chrome.action`), through a small popup window per extension.
   - Bookmark manager: rename, move and drag to reorder; drag a tab onto the bookmarks bar.
   - Site settings page (per-site permissions, cookies, zoom).
   - Download "show in folder" for completed files in the toolbar flyout.
   - Picture-in-picture button for videos.
2. Engineer features from the proposal doc:
   - Part and datasheet lookup card (`!part LM317`).
   - Dev toolbox panel (JSON/YAML, JWT, Base64, regex, cron, timestamps, UUID).
   - Focus timer panel using the existing focus module.
3. Release hygiene: code signing; keep CHANGELOG and this file updated; bump the version for each installer.

## Prompt to continue in another AI tool (paste as is)

> You are continuing development of AETHER, a privacy-first Electron desktop browser in this folder (`C:\Users\Kailash A\Desktop\Projects\Aether Browser`). Read `HANDOFF.md`, `CHANGELOG.md`, `README.md` and `docs/architecture.md` first, then `docs/threat-model.md`.
>
> Rules:
> - Keep the security invariants in HANDOFF.md: sandboxed web views, validated IPC, no network for the UI session, safeStorage for secrets.
> - Never add features that bypass site authentication or evade AI detectors.
> - Keep it lightweight: lazy-load heavy code, with no background work while a feature is unused.
> - Every new IPC channel goes in `src/shared/types.ts` `INVOKE_CHANNELS` and `src/main/ipc.ts`, with a validator.
> - New schema changes are new migrations in `packages/storage/src/schema.ts` (never edit old ones).
> - Add unit tests (vitest) and, for UI flows, a scenario in `apps/desktop/test/e2e/run.mjs`.
> - Run `npm test` and `npm run test:e2e -w @aether/desktop` before you finish.
>
> Task: implement the "Next steps" in HANDOFF.md in order, starting with extension toolbar buttons and the bookmark manager.
>
> For each finished item:
> 1. Update CHANGELOG.md under a new version.
> 2. Bump `apps/desktop/package.json` version.
> 3. Run `npm run dist:win -w @aether/desktop`.
> 4. Copy `apps\desktop\release\AETHER-Setup-<version>.exe` and `latest.json` into `releases\` so the installed app offers the update.
> 5. Update HANDOFF.md ("Current state" and "Next steps").
>
> State clearly what is implemented versus prototype.
