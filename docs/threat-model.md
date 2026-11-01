# Threat model (v0.1)

Scope: the desktop shell and its IPC. Privacy-module specifics (blocking lists, HTTPS upgrade) are in `packages/protection-module/README.md`.

## Assets

1. Website sessions (cookies, tokens) for each profile, e.g. university SSO and Google accounts.
2. Local data: history, bookmarks, notes, workspaces, time-tracking records.
3. The user's machine: AETHER's main process runs with the user's privileges.
4. Separation between profiles (one profile must not read another's sessions).

## Adversaries

| Adversary | Capability |
|---|---|
| Malicious or compromised website | Arbitrary JS/HTML in a tab, popups, downloads, permission prompts, phishing UI |
| Cross-profile tracker | Wants to correlate the user across profiles |
| Malicious file / download | Executables, documents with exploits |
| Local attacker with the user's account | Can read `%APPDATA%` (out of scope to defend; see limits) |
| Supply chain | A compromised npm dependency |

## Controls

| Threat | Control | Where |
|---|---|---|
| Web page reaches privileged APIs | Web views: sandbox, context isolation, no preload, no node, no `<webview>`; bridge only in the UI WebContents | `tab.ts`, `window.ts`, `index.ts` |
| Forged IPC from web content / iframes | Each handler checks the sender is a registered UI WebContents, its main frame, from the app origin; payloads validated with strict schemas | `ipc.ts`, `validate.ts` |
| UI hijacked to load remote code | UI partition `aether-ui` cancels all non-file requests; strict CSP (`script-src 'self'`, `img-src 'self' data:`); UI cannot navigate or open windows | `index.ts`, `renderer/index.html`, `window.ts` |
| Favicons leaking from the privileged UI | Favicons fetched in main through the tab's own session and passed as `data:` URLs (≤64 KB) | `favicons.ts` |
| Cross-profile tracking | Separate persistent partitions per profile; separate in-memory partition per private window | `sessions.ts` |
| Script URLs typed or pasted | Address bar refuses `javascript:`, `data:`, `vbscript:`, `blob:`, `chrome:` | `packages/omnibox` |
| Internal pages abused | `aether://` pages carry `default-src 'none'` CSP, no scripts, no IPC; actions are GET+redirect | `internal-pages.ts` |
| Permission abuse (camera, mic, location, notifications, clipboard read) | Prompt per origin, remembered per profile only on request, denied by default after 2 min; WebUSB/HID/Serial/Bluetooth denied until a picker exists | `sessions.ts`, `PermissionBar.tsx` |
| Popups / window.open phishing | Plain links open as tabs; feature popups (OAuth) open in a small sandboxed window with the same session and no further popups | `window.ts` |
| Download overwrite / path tricks | Filenames sanitised (Windows reserved names, control chars), never overwrite existing files | `downloads.ts` |
| Saved password stolen from disk | Encrypted with the OS keychain (`safeStorage`, DPAPI on Windows); if the OS offers no encryption, AETHER refuses to store passwords rather than store plaintext | `passwords.ts`, `credentials.ts` |
| Saved password filled into the wrong site | Fill only on user click; the tab's committed URL is re-checked against the login's registrable domain immediately before injecting; top frame only; never on `http` for an `https` login; isolated world 1002 | `passwords.ts` |
| Password left on the clipboard | Copied passwords are cleared after 30 s if the clipboard still holds them | `passwords.ts` |
| Plain-text CSV left behind after import | After import AETHER offers to delete the CSV; exports warn first | `passwords.ts` |
| Cosmetic-filter channel abused by a page | The content preload is sandboxed and context-isolated and exposes nothing to the page; the main process uses the frame URL it knows (never one the page sends), serves only web sessions, validates DOM name lists (≤2000 × 500 chars), and replies with filter CSS/scriptlets only | `preload/content.ts`, `ipc.ts` |
| Scriptlets run in the page's main world | Only scriptlets named by the downloaded uBlock/EasyList rules and Ghostery's resource bundle; user custom rules can add `##` hiding but scriptlets only come from lists | `privacy/protection.ts` |
| Tampered update installer | Updates come only from the local `releases` folder; the installer's SHA-256 must match `latest.json` before it runs. Anyone who can write that folder can also replace the manifest, so the folder's own Windows permissions are the trust boundary until code signing exists | `updater.ts` |
| A module bug crashing the browser | Module calls wrapped; interceptors fail open; logged | `module-host.ts` |
| Tab crash / hang | Per-tab process; recovery screen; UI renderer auto-reload | `window.ts` |

## Known limits (honest list)

- **No sandbox for the local machine against the user**: data at rest is not encrypted by AETHER. Cookies are protected by Chromium's OS-level encryption (DPAPI on Windows) as in Chrome; the SQLite file is plain. Profile "lock" is **not implemented**.
- **Mark-of-the-Web**: Electron does not tag downloads with Windows' Zone.Identifier the way Chrome does, so SmartScreen may not warn on downloaded executables. **Planned**: write the zone stream after download.
- **Safe Browsing** is not available in Electron. Phishing/malware URL checks are **not implemented**.
- **Passwords from Google**: Google has no public API that lets a third-party browser read Google Password Manager. AETHER does not scrape, automate or bypass Google's export. The supported route is: sign in to Google in the profile, export from passwords.google.com (Google asks for the account password), and import the CSV. There is no two-way sync back to Google.
- **Password manager limits (v0.1)**: no automatic save-on-submit prompt yet, no master password or re-authentication before reveal/copy (anyone using the unlocked OS account can view saved passwords, as in Chrome without its optional OS-auth setting), no breach checks, no passkeys.
- **Google sign-in**: AETHER presents a truthful Chromium user agent without the Electron token. Google may still decline sign-in for embedded-framework browsers; AETHER does not try to bypass that.
- **Extensions**: Chrome extensions are not supported in v0.1.
- **Spellcheck dictionaries** are downloaded by Chromium from Google's CDN (`redirector.gvt1.com`) the first time they are needed.
- `node:sqlite` is marked experimental in Node 22; it is isolated behind `@aether/storage` so it can be swapped for `better-sqlite3`.
- Dependency risk is limited by keeping runtime dependencies minimal (React, the adblocker engine, tldts); everything is bundled at build time, and `npm audit` should be part of release CI (**planned**).
