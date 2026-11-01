# AETHER Research & Writing module (`aether.module.research`)

An installable AETHER module (contract v2) that turns the browser into a literature-review workstation on top of the core's shared citation library and the built-in Writer.

## Apps

| App id | What it does |
|---|---|
| `research.review` | Literature Review: discovery (Crossref, OpenAlex, arXiv, PubMed, optional Semantic Scholar; Google Scholar as a link only), reading queue with topic/methodology/domain/dataset/application tags and relevance, review projects with scope and inclusion/exclusion criteria, screening with PRISMA-style counts, research questions with sub-questions and refinement checklist, evidence (stance, quote, page), extraction of objective/methods/datasets/metrics/findings/limitations/future work, comparison matrix and benchmark table, gap hypotheses, citation graph and related papers, topic timeline, cited outline and full report sent to the Writer, project file export/import. |
| `research.verify` | Reference Check: verifies the shared library against Crossref, doi.org (DataCite etc.) and arXiv, finds likely DOIs for references without one, reports retraction/correction notices (Crossref + Retraction Watch, OpenAlex), offers per-field corrections, and an offline citation-quality report. |
| `research.library` | Offline Library: save the current page (MHTML archive + text), ranked full-text search, offline reader. |
| `research.trail` | Research Trail: opt-in per-workspace list of visited pages (origin + path only), 30-day retention, never private windows. |

## Services for other modules

* `writing.checkCitations { markdown, refs, attachedIds?, useAi? }` → unknown keys, never-cited references, uncited claims, and a per-citation support check against the source's abstract, accepted extractions, linked evidence and saved pages. Lexical aid only; it says so in `limits`.

## Honesty rules built in

* Nothing is generated as a reference, finding, quote or gap. Discovery shows only records returned by the services; empty matrix cells stay empty; outline bullets always cite linked evidence; gap hypotheses list their basis and a caveat.
* Heuristic and AI extraction produce *suggestions* only. AI suggestions are dropped unless their quote appears verbatim in the source text; AI "supports" verdicts without a real quote are discarded.
* Verification reports; it never edits a reference unless the user applies a correction.

## Security and privacy

* All network goes through `LabNet` (src/net.ts): off by default, https only, fixed host allowlist (mirrors the manifest's `net:` permissions; the core re-checks every redirect hop), per-host pacing (arXiv 3 s, NCBI 350 ms, S2 1.1 s), 15 s timeout, 5 MB cap, metadata-only request log shown in Settings.
* Every IPC payload is validated (src/validate.ts): ids are restricted, prototype keys rejected, references are copied field-by-field with size caps.
* Private windows: projects and searches in memory only, no saved pages, no trail.
* API keys (OpenAlex, Semantic Scholar) only via `host.secrets` (OS encryption); the UI only learns whether a key exists.
* Links leave the module only if http(s). CSV export guards against formula injection.
* `profileDeleted` removes all rows, cached graphs, settings and keys for the profile.

## Data

Own SQLite (`host.storage.db`), table `module_research_docs` partitioned by collection and profile. Saved-page archives in `<dataDir>/pages/<id>.mhtml`.

## Limits

See `manifest.limits`. Notably: no full-text PDF table/figure extraction yet (text comes from abstracts, pasted text, the current tab or saved pages); no Zotero live sync (BibTeX/RIS import in the core library covers Zotero exports); no video/lecture summarisation; the citation graph covers sources with DOIs indexed by OpenAlex.

## Tests

`npx vitest run packages/module-research` (50 tests: network guard, discovery mappers and merge, verification, quality, extraction, analysis, graph, support check, main-module IPC on `node:sqlite`, hardening, jsdom UI smoke tests).
