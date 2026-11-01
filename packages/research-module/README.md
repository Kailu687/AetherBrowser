# AETHER research, notes and writing modules

Spec sections 8–15 and 17: source capture, citations, annotations, PDF reading,
the Markdown + LaTeX notebook, the paper writer, optional AI, and engineering
calculators. Every package is plain TypeScript consumed as source
(`main`/`types`/`exports` point at `src/index.ts`), with React UI in a separate
`./ui` entry so main-process code never pulls in React.

## Packages

| Package | What it does | Status |
|---|---|---|
| `@aether/research-core` | `Collection` storage interface, ids, emitter | Implemented |
| `@aether/citations` | CSL-JSON model; APA 7, IEEE, MLA 9, Chicago 17 (author-date) references and in-text citations; IEEE numbering and range collapsing; APA/Chicago 2020a/b disambiguation; BibTeX parse/export (macros, `#`, accents, error recovery); RIS import/export; reference validation and duplicate detection; plain/HTML/Markdown/LaTeX output | Implemented. Titles are used as entered (no automatic sentence/title casing). Chicago notes-bibliography is not implemented. |
| `@aether/sources` | arXiv Atom and Crossref mapping, DOI content negotiation fallback, Highwire `citation_*` / Dublin Core / JSON-LD / OpenGraph extraction, ISBN validation, `captureSource` (offline unless the user enables lookups) | Implemented |
| `@aether/annotations` | W3C Web Annotation selectors; re-anchoring by position, quote + context, then whitespace-insensitive match; orphan detection; Markdown quote export with `[@key, p. N]`; DOM highlight helpers (`./dom`) for the isolated world / PDF text layer | Implemented. Drawing highlights on live web pages needs the shell's isolated-world script to call `./dom`. |
| `@aether/pdf-viewer` | Lazy pdf.js engine (scripting and XFA off), text extraction and search, outline, metadata → reference with DOI/arXiv detection, virtualised React viewer with text layer and highlight button | Engine and metadata tested in Node. The React viewer renders canvases and needs a manual check in Electron (not covered by automated tests). |
| `@aether/notebook` | Notes per profile and workspace, Markdown with `$inline$`/`$$display$$` math (KaTeX loaded only when a note has math), `[[wiki links]]`, `#tags`, `[@key]` citations, task lists, quick capture into a daily workspace inbox, ranked search, backlinks, Markdown+YAML import/export, editor panel with autosave | Implemented |
| `@aether/paper-editor` | 7 templates (IEEE conference, APA paper, literature review, lab report, technical/internship report, thesis chapter, blank); sections, reordering, versions; checks for unresolved/uncited references, claims without sources, word targets, long sentences, incomplete references; readability; AI-assistance log and draft disclosure statement; export to IEEEtran/article LaTeX + `.bib`, Markdown, pandoc Markdown, print-ready HTML | Implemented. The claim check is a heuristic hint, not a guarantee. |
| `@aether/ai` | Provider interface; Ollama, any OpenAI-compatible server (LM Studio, llama.cpp, vLLM), and Claude via the official Anthropic SDK; `AiGateway` with master switch (off by default), per-provider per-scope consent with expiry, cloud redaction, and a metadata-only audit log; grounded prompt builders | Implemented. Providers are tested against mocked servers, not live endpoints. |
| `@aether/calculators` | Safe expression evaluator (SI suffixes, `||` for parallel, constants, variables, no `eval`); unit conversion with prefixes and compound units; electronics (Ohm, divider, RC/RL/LC, LED, 555, colour codes, E-series, AWG, IPC-2221); ISA atmosphere, lift/stall/Reynolds, beams; base conversion, two's complement, EMI, stats, line fit; scratchpad + calculator panel | Implemented |
| `@aether/research-module` | Shell integration through `@aether/plugin-api`: SQLite storage partitioned by profile, in-memory storage for private windows, validated IPC handlers, deletion on `profileDeleted`, and five lazily loaded sidebar panels (Notebook, Library, Writer, Calculator, Assistant) | Implemented and tested with a fake host on `node:sqlite`; not yet exercised inside the real Electron shell. |

## Wiring into the shell

```ts
// apps/desktop/src/main/modules.ts
import { researchMainModule } from "@aether/research-module";
export const MAIN_MODULES = [/* ... */, researchMainModule];

// apps/desktop/src/renderer/modules.ts
import { researchRendererModule } from "@aether/research-module/renderer";
export const RENDERER_MODULES = [/* ... */, researchRendererModule];
```

Also needed from the shell:

* **KaTeX CSS** in the renderer: `import "katex/dist/katex.min.css"`.
* **pdf.js worker**: `configurePdfEngine({ workerSrc })` with the URL of
  `pdfjs-dist/build/pdf.worker.min.mjs` (Vite: `import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url"`).
* **API keys**: if the host exposes `secrets: { get, set, delete }` backed by
  Electron `safeStorage`, keys persist encrypted; otherwise they are kept in
  memory only until restart.
* **Tests**: the `.tsx` UI tests use `// @vitest-environment jsdom`; the root
  Vitest `include` needs `packages/*/test/**/*.test.{ts,tsx}`.

## Privacy defaults

* No network access unless the user turns on DOI/arXiv lookups (sends only the identifier) or configures an AI provider.
* AI is off until enabled. Cloud providers need consent per data type (selection, page, PDF, note, draft, references); local loopback providers do not, unless "Ask before sending to local models" is on. Only loopback endpoints are labelled local.
* The audit log stores metadata (time, provider, host, purpose, scopes, sizes, outcome), never prompt text.
* Private windows keep research data in memory only.

## Academic integrity

The writer helps produce sourced, defensible work: citations must resolve,
claims are flagged when they lack sources, AI suggestions must be explicitly
accepted and are logged, and a disclosure statement is drafted from that log.
It does not attempt to disguise AI-generated text or to evade AI detectors.
