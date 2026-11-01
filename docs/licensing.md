# Licensing plan

**AETHER's own code: MPL-2.0** (file-level copyleft). Rationale: keeps improvements to AETHER files open while allowing them to be combined with code under other licences, and matches the licence of the main runtime dependency for blocking (Ghostery adblocker, MPL-2.0). It is GPL-compatible, so GPL-licensed filter lists can be used without being bundled.

| Component | Licence | How it is used | Obligation |
|---|---|---|---|
| Electron | MIT | Runtime, redistributed in the installer | Ship licence (Electron's `LICENSE`) |
| Chromium (inside Electron) | BSD-3 + many third-party licences | Redistributed | Ship `LICENSES.chromium.html` (electron-builder includes it) |
| React, React DOM | MIT | Bundled into the UI | Notice in about/licences file |
| Vite, esbuild, TypeScript, Vitest, Playwright | MIT / Apache-2.0 | Build and test only | None for distribution |
| `@ghostery/adblocker` | MPL-2.0 | Bundled into main | Keep its files under MPL; source available |
| tldts | MIT | Bundled | Notice |
| EasyList, EasyPrivacy, uBlock filters | GPL-3.0 / CC-BY-SA-3.0 | **Downloaded at runtime, not bundled** | None for our distribution; attribution shown in the privacy panel |
| SQLite (inside Node/Electron) | Public domain | Runtime | None |

Before a public release: run a licence scanner over the bundled output (e.g. `license-checker` on production deps), generate `THIRD_PARTY_NOTICES.txt` into the installer, and check the provisional name "AETHER" for trademark, package-name and domain conflicts.
