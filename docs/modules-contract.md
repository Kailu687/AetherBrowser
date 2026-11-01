# AETHER Modules contract (v2)

Owner: the Core/integration thread. Status: **v2.0, 2026-11-01**. "Labs" are now **Modules** everywhere (code, ids, UI, docs).
Types live in `packages/plugin-api/src/index.ts`: `ModuleManifest`, `ModulePermission`, `ModuleAppInfo`, `ModuleCategory`,
`ModuleExternalApp`, `ProcessService`, `WorkbenchAppDefinition`, `WorkbenchAppApi`. (`LabManifest`/`LabPermission`/`LabAppInfo`
remain as deprecated aliases so v1 code still compiles; switch when convenient.)

## What changed from v1.1

| v1.1 | v2 |
|---|---|
| `LabManifest`, `manifest: 1`, `layer: 'lab'` | `ModuleManifest`, `manifest: 2`, `layer: 'module'` |
| id `aether.lab.<name>` | id `aether.module.<name>` |
| `packages/lab-<name>`, `@aether/lab-<name>` | `packages/module-<name>`, `@aether/module-<name>` |
| error `lab-not-installed:<id>` | `module-not-installed:<id>` |
| — | required `license` (SPDX); optional `os`, `externalApps`, `sizeMb`, `changelog`, `advisories` |
| categories | added `developer`, `math` |
| Add-on Store | **Module Store**; modules can be **disabled** without uninstalling; **safe mode** starts with every module off |

## Layers

| Layer | What | Where it runs |
|---|---|---|
| Core | browser, profiles, windows, privacy, focus, storage, AI controls, Google account, module manager + permission broker, shared utilities (calculator, units, notebook, capture, search) | main + privileged UI |
| Built in (Studio) | Writer (`@aether/writer`), Code (`@aether/ide`), Projects / Project Intelligence (`@aether/projects`), Engineering tools | ships with the app |
| Modules | Research & Writing, Electronics & ECE, Developer, Aerospace & Space (incl. RF), Mechanical, Civil & Structural, Biotech, Data Science & AI, Math/Physics/Computing | installable from the Module Store |

## Package layout

```
packages/module-<name>/
  package.json          name "@aether/module-<name>", exports "." -> src/index.ts, "./ui" -> src/ui/index.ts
  src/index.ts          export const manifest: ModuleManifest; export function createMainModule(): AetherMainModule
  src/ui/index.ts       export const rendererModule: AetherRendererModule  (apps + optional panels)
  test/*.test.ts        vitest; no Electron imports (use a fake MainHost)
```

Agreed names: `research`, `electronics`, `devstudio`, `aerospace`, `mechanical`, `civil`, `bio`, `data`, `mathphys`
→ ids `aether.module.research`, `aether.module.electronics`, … Shared helpers may live in `packages/module-kit`
(`@aether/module-kit`, not installable, no manifest); the core's `validateManifest` in `@aether/addons` stays authoritative.

* Module id = manifest id = main module id = IPC namespace = `rendererModule.id`.
* Workbench app ids: `<name>.<app>` (e.g. `electronics.circuit`). Each app's and panel's `addon` field = the Module id.
* Apps load lazily: `component` is a light wrapper around `React.lazy(() => import(...))`.
* Never import `electron`. Never import another Module's internals; call its IPC through `api.invokeModule` and list it in `dependencies`.
* UI uses the Workbench classes (`wb-btn`, `wb-input`, `wb-select`, `wb-panel`, `wb-card`, `wb-table`, `wb-side`, `wb-content`,
  `wb-form`, `wb-results`, `wb-modal`) and theme tokens (`--bg --surface --surface-2 --line --fg --muted --accent --accent-2 --danger --ok`).
  Prefix Module CSS classes (`.elx-…`).
* All user-facing text says "module", never "lab" or "add-on pack".

## Manifest (schema 2)

Required: `manifest: 2`, `id`, `name`, `version` (semver), `layer: 'module'`, `category`, `icon`, `color`, `tagline`,
`description`, `engines.aether` (semver range, e.g. `">=0.4.0"`), `permissions`, `network`, `features`, `limits` (honest,
non-empty), `apps`, `license`.
Optional: `os` (`win32|darwin|linux`), `dependencies` (`{ "aether.module.mechanical": "^1.0.0" }`), `externalApps`
(`{ program, name, optional, purpose, url? }` — e.g. ngspice, kicad-cli, esptool; never bundled, checked with `processes.which`),
`sizeMb`, `changelog`, `advisories`, `integrity`.

## Permissions (closed vocabulary)

| Permission | Grants | Risk |
|---|---|---|
| `storage` | own SQLite file `<dataDir>/module.sqlite` (via `host.storage.db`), kv, dataDir. Implicit. | low |
| `net:<host>` | `host.net.fetch` to that https host only (`net:*.example.org` for subdomains). **Every redirect hop is re-checked.** | low |
| `net:localhost` | http(s) to localhost / 127.0.0.1 / [::1], any port (dev servers, local kernels, Ollama) | low |
| `net:user` | any http(s) host the user typed; the core asks the user once per new host | medium |
| `tabs.read` | `host.tabs.getPageContent`, `host.tabs.savePage` (call only from a user action) | low |
| `files.pick` | `host.dialogs.openFile/saveFile` | medium |
| `files.folder` | `host.dialogs.openFolder`; read/write only under folders returned by it | medium |
| `process.run` | `host.processes.which/run`: installed program, argv only, no shell, timeout, output cap; user approves each program once | high |
| `process.servers` | `host.processes.start/input/stop/on`: long-running commands incl. shell (Developer only) | high |
| `ai.optional` | `host.ai.run` when the user enabled AI and consented to the scope; null otherwise | low |
| `secrets` | `host.secrets` scoped to the Module | low |

Never grantable: cookies, saved passwords, browsing history, the shared core database, other modules' data, session
`webRequest`, frame injection, navigation interception, `host.shellData`, Google tokens.

In-process listeners (e.g. Developer's API mock server via `node:http`): allowed only if the Module lists `net:localhost`,
binds `127.0.0.1` only, starts on an explicit user action, and closes in `deactivate()`.

## What the core enforces

1. **Install gate.** A Module's IPC is dispatched only when it is installed **and enabled** for the calling profile and safe
   mode is off; otherwise `module-not-installed:<id>`. Install requires approving every listed permission in the Module
   Store; engines, OS and dependencies are checked; a dependency can't be removed or disabled while a dependent is enabled.
2. **Scoped host.** Members not granted are `undefined`; `net.fetch` enforces the host list on every redirect; `storage.db`
   is the Module's own SQLite file; `sessions`, `content`, `navigation`, `shellData`, `internalPages` are no-ops.
3. **Manifest digest.** A changed manifest (new version or permissions) shows "Review permissions"; only previously approved
   permissions stay active until the user re-approves.
4. **Processes.** Per-program approval, `shell: false` for `run`, scrubbed environment, cwd must be the Module dataDir or an
   approved folder, 2 MB output cap, default 60 s timeout.
5. **Safe mode.** Settings → Modules → "Restart in safe mode" (or `--safe-mode`) starts with every Module's main code not
   activated and its apps hidden.

**Known limit:** Modules are first-party code bundled in the signed installer. Their React UI runs in the privileged browser
UI process, so UI isolation is by review, not by sandbox. Third-party Modules are **not** supported until the sandboxed
module runtime (own WebContentsView + capability bridge) lands.

## Registering (the Core thread does this at integration)

```ts
// apps/desktop/src/main/addon-modules.ts
import { manifest as electronics, createMainModule as electronicsMain } from '@aether/module-electronics';
export const INSTALLABLE = [{ manifest: electronics, main: electronicsMain }];
// apps/desktop/src/renderer/addon-modules.ts
import { rendererModule as electronicsUi } from '@aether/module-electronics/ui';
export const MODULE_UIS = [electronicsUi];
```

## Built-in services Modules can call (through `api.invokeModule`)

* `aether.writer` — `createFromMarkdown { title, markdown, template? }` → `{ id }` (opens in Writer with `api.openApp('writer', id)`).
* `aether.projects` — `list`, `addItem { projectId, kind, ref, title, meta? }`, `addRequirement`, `addValidation
  { requirementId, value, unit, source, status: 'proposed'|'calculated'|'simulated'|'measured'|'reviewed'|'verified' }`.
  Satisfied only counts with `verified`/`measured`/`reviewed` evidence.
* `research` — library, citations (core research module).

## Hand-off

Drop the package directory (no node_modules) at `/mnt/project-files/aether-modules/<name>/packages/module-<name>/` with tests
passing under the root vitest config, list new npm dependencies (name + version + licence) in a `DEPS.md`, and message the
Core thread. The Core thread merges, runs the full test + e2e suite, builds the installer and syncs to the PC.
