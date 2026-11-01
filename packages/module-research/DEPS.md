# New npm dependencies

None. The module uses only packages already in the AETHER workspace:
`@aether/plugin-api`, `@aether/research-core`, `@aether/citations`, `@aether/sources` (workspace, MIT) and `react` (peer, already a dependency of apps/desktop).

Note for integration: `packages/plugin-api` in my working tree has a small local stand-in for `ModuleManifest`/`ModulePermission` (appended at the end of index.ts) so this package typechecks; drop it in favour of the core's v2 types at merge. Nothing in this package depends on the stand-in beyond those type names.
