# AETHER

**Browse deeply. Research intelligently. Build without distraction.**

A privacy-focused, local-first desktop browser for engineers, students, researchers and anyone who juggles several identities and projects. Built on Electron 38 (Chromium 140) with a React + TypeScript UI and a local SQLite database. No account, cloud service or telemetry is needed.

> "AETHER" is a provisional name until trademark, package and domain checks are done.

## Install (Windows 10/11)

Run `releases\AETHER-Setup-<version>.exe`. It installs for your user only (no admin), and adds AETHER to the desktop and the Start menu. Windows SmartScreen may warn the first time because the build is not code-signed yet; choose **More info → Run anyway**.

New versions appear in `releases\` with a `latest.json`. AETHER notices them and offers **Restart and update**; your windows and tabs come back afterwards. See [CHANGELOG.md](CHANGELOG.md) for what changed, and [HANDOFF.md](HANDOFF.md) for the developer briefing.

## Run from source (Windows 10/11)

Requires Node.js 22.13 or newer.

```powershell
npm install
npm run build
npm start            # launches the browser
npm run dev          # UI hot reload + main rebuild, for development
npm test             # unit tests (all packages)
npm run test:e2e     # launches the real app and runs end-to-end scenarios
npm run dist:win     # builds the NSIS installer + latest.json into apps/desktop/release
```

Data lives in `%APPDATA%\AETHER`. Set `AETHER_USER_DATA` to use a different folder (handy for a portable or test profile).

## What works today

| Area | Status |
|---|---|
| Profiles with genuinely isolated storage (cookies, sign-ins, cache, site data, history, bookmarks, downloads, permissions, workspaces, search engine) | Implemented |
| Create, rename, recolour, export, delete profiles (deletion explains what is removed) | Implemented |
| Multiple independent windows per profile, geometry restored, kept on screen | Implemented |
| **Keep this window?** on close, with "remember my choice" per profile; kept windows and tabs reopen on start or when you open the profile | Implemented |
| Crash-safe session checkpoints (window state saved within ~1.5 s of any change) | Implemented |
| Workspaces: switch a window between research contexts; tabs, active tab, reading positions and notes are saved and restored | Implemented |
| Quick notes ("thoughts") per workspace or a profile inbox, saved locally | Implemented |
| Tabs: pin, mute, duplicate, drag to reorder, reopen closed, middle-click, context menus | Implemented |
| Split view (two tabs side by side, draggable divider) | Implemented |
| Address bar: URL/search detection, suggestions from history, bookmarks and open tabs, 30+ `!bang` shortcuts (`!scholar`, `!arxiv`, `!ieee`, `!ds`, `!dk`, `!mouser`, `!octo`, `!gh`, `!so`, `!wa`, `!doi`, `!yt`...) | Implemented |
| Command palette (Ctrl+K) for tabs, workspaces, profiles and actions | Implemented |
| Bookmarks with folders, history with search and range clearing, downloads with pause/resume/cancel/open | Implemented |
| Private windows (in-memory, wiped on close, no history) | Implemented |
| Find in page, zoom, print, save page, view source, DevTools, built-in PDF viewer | Implemented |
| Site permission prompts remembered per profile | Implemented |
| Themes: **AETHER** (signature default), **Aviation** (glass-cockpit: avionics amber/green, flight-strip tabs, heading-tape title bar, instrument new-tab page with attitude indicator, UTC clock and flight-plan of top sites), Daylight, Midnight, Paper, High contrast, or follow the OS | Implemented |
| Password manager per profile: OS-encrypted store, fill on click for the matching site, copy with 30 s clipboard clear, import from Google Password Manager / Chrome / Edge / Firefox CSV, export | Implemented (no auto-save prompt or master password yet) |
| Memory saver (sleeping background tabs), lazy tab restore | Implemented |
| Crash recovery screen per tab; UI renderer auto-recovery; offline/DNS/TLS error screens | Implemented |
| Ad and tracker blocking on by default: network rules plus element hiding and uBlock scriptlets (EasyList, EasyPrivacy, uBlock filters incl. quick fixes, badware, resource abuse); per-site off switch; custom filters | Implemented |
| Address-bar calculator with units: `= 3.3V / 470ohm in mA`, `12 kN*m to lbf*ft`, `255 to hex`, `100 °C to °F`, `10k \|\| 10k` (Enter copies) | Implemented |
| Windows installer with desktop shortcut; local-folder updates with checksum check | Implemented |
| Bookmarks bar (Ctrl+Shift+B), reader view (Ctrl+Alt+R), tab groups (colours, names, collapse, saved with sessions) | Implemented |
| Save-password offer after sign-in; calculate a selected formula from the right-click menu | Implemented |
| Unpacked Chrome extensions per profile (content scripts, background workers; no toolbar popups yet) | Experimental |
| Focus modes, local time tracking (`packages/focus`, `activity`) | Implemented as modules |
| Research sidebar, citations, paper writer | In progress (sibling packages) |
| Optional AI providers | Not started |
| Chrome Web Store, extension popups, profile lock, Safe Browsing, Mark-of-the-Web on downloads, auto-update | Not implemented (see `docs/threat-model.md`) |

## Your Google passwords

Google does not offer any app a way to read your saved passwords, so AETHER cannot "link" to them live. What works:

1. Open **Passwords** in the sidebar (key icon, or Ctrl+Shift+L) and choose **Import from Google**.
2. Sign in to Google in that tab, choose **Export passwords**, and confirm with your Google password.
3. When the CSV finishes downloading AETHER offers to import it, then offers to delete the plain-text file.

Passwords are stored encrypted with your Windows account and are only filled when you click **Fill** on the matching site.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl+T / Ctrl+W / Ctrl+Shift+T | New tab / close tab / reopen closed tab |
| Ctrl+N / Ctrl+Shift+N | New window / new private window |
| Ctrl+L, Alt+D, F6 | Focus address bar |
| Ctrl+K | Command palette |
| Ctrl+Tab, Ctrl+1..9 | Switch tabs |
| Ctrl+\\ | Split view |
| Ctrl+B / Ctrl+Shift+K / Ctrl+Shift+L | Sidebar / notes / passwords |
| Ctrl+D / Ctrl+H / Ctrl+J / Ctrl+Shift+O | Bookmark / history / downloads / bookmarks |
| Ctrl+F, Ctrl+P, Ctrl+S, Ctrl+U | Find, print, save page, view source |
| Ctrl+= / Ctrl+- / Ctrl+0 | Zoom |
| F5 / Ctrl+R, Alt+Left/Right, F11, F12 | Reload, back/forward, full screen, DevTools |

## Repository layout

```
apps/desktop          Electron app (main, preload, React UI, e2e tests, packaging)
packages/plugin-api   Contract for feature modules (types only)
packages/storage      SQLite schema and repositories
packages/omnibox      Address-bar parsing and bang shortcuts
packages/web-request-hub, privacy, focus, activity, protection-module   Privacy, focus and time tracking
docs/                 Architecture, modules, data model, threat model, licensing
```

Start with [docs/architecture.md](docs/architecture.md). Feature modules plug in through [docs/modules.md](docs/modules.md).

## Licence

MPL-2.0. See [docs/licensing.md](docs/licensing.md) for third-party components.
