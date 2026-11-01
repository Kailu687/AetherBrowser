import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AetherMainModule, MainHost } from "@aether/plugin-api";
import { createId } from "@aether/research-core";
import type { Reference } from "@aether/citations";
import { DEFAULT_LAB_SETTINGS, EXTRACTION_FIELDS, SERVICE_INFO, type DiscoveryService, type Evidence, type ExtractionItem, type GapDecision, type LabProject, type LabSettings, type NetworkLogEntry, type ResearchQuestion, type SavedPage, type TrailEntry, type VerificationRecord } from "./model.js";
import { LabNet, type FetchLike } from "./net.js";
import { discover, type DiscoveryRun, type ServiceCredentials } from "./discovery.js";
import { applyCorrections, verifyReference } from "./verify.js";
import { citedKeys, qualityReport } from "./quality.js";
import { extractionPrompt, heuristicSuggestions, parseAiSuggestions, type Suggestion } from "./extraction.js";
import { DEFAULT_CRITERIA, buildMatrix, buildOutline, gapHypotheses, matrixToCsv, matrixToMarkdown, outlineToMarkdown, screeningCounts } from "./analysis.js";
import { MODULE_MIGRATIONS, createStores, deleteProfile, searchSaved, type ModuleStores } from "./store.js";
import { PayloadError, bool, id, obj, oneOf, optId, optInt, optStr, reference, references, str, strArray, type Obj } from "./validate.js";
import { safeUrl } from "./text.js";
import { googleScholarUrl } from "./discovery.js";
import { citationGraph, projectTimeline, topicTimeline } from "./graph.js";
import { checkCitations, parseSupport, supportPrompt } from "./support.js";
import { benchmarkTable, refinePrompt, refineQuestion, reviewReport } from "./review.js";
import { sourceLabel, sourcesMentioning } from "./analysis.js";
import { TAG_FACETS, type ReadingItem } from "./model.js";

export const MODULE_ID = "aether.module.research";

type Ctx = { windowId: number; profileId: string; isPrivate: boolean };
type Handler = (p: Obj, s: ProfileState, ctx: Ctx) => unknown;

interface ProfileState {
  stores: ModuleStores;
  log: NetworkLogEntry[];
  net: LabNet;
  searches: DiscoveryRun[];
}

const SERVICES = Object.keys(SERVICE_INFO) as DiscoveryService[];
const MAX_TEXT = 2_000_000;

/**
 * Main-process half of the Research & Writing module. Holds the module's own data (projects,
 * questions, evidence, extractions, verification records, saved pages, trail)
 * in the module's SQLite file. The shared reference library stays in the core
 * research module; the UI reads it there and hands this module the
 * references it needs, so the module never touches another module's tables.
 */
export function createMainModule(): AetherMainModule & { state(profileId: string, isPrivate?: boolean): ProfileState } {
  let host: MainHost;
  const persistent = new Map<string, ProfileState>();
  const ephemeral = new Map<string, ProfileState>();
  const unsubs: Array<() => void> = [];
  // Trail writes are read-modify-write; run them one at a time.
  let trailQueue: Promise<void> = Promise.resolve();

  const settings = (profileId: string): LabSettings => {
    const saved = host.storage.kv.get<Partial<LabSettings>>("settings", profileId) ?? {};
    return { ...DEFAULT_LAB_SETTINGS, ...saved, services: { ...DEFAULT_LAB_SETTINGS.services, ...(saved.services ?? {}) } };
  };
  const secret = (name: string): string | undefined => {
    try {
      return host.secrets?.get(name) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const cred = (profileId: string): ServiceCredentials => ({ mailto: settings(profileId).mailto, openalexKey: secret(`${profileId}:openalex`), semanticScholarKey: secret(`${profileId}:semanticscholar`) });

  function state(profileId: string, isPrivate = false): ProfileState {
    const cache = isPrivate ? ephemeral : persistent;
    let s = cache.get(profileId);
    if (s) return s;
    const log: NetworkLogEntry[] = [];
    const fetch: FetchLike = (url, init) => host.net.fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
    s = {
      stores: createStores(isPrivate ? null : host.storage.db, profileId),
      log,
      searches: isPrivate ? [] : (host.storage.kv.get<DiscoveryRun[]>("searches", profileId) ?? []),
      net: new LabNet({ fetch, isOnline: () => settings(profileId).online, log: (e) => (log.unshift(e), log.length > 300 && log.pop()) }),
    };
    cache.set(profileId, s);
    return s;
  }

  const now = () => new Date().toISOString();
  const entity = () => ({ id: createId(), createdAt: now(), updatedAt: now() });

  async function project(s: ProfileState, projectId: string): Promise<LabProject> {
    const p = await s.stores.projects.get(projectId);
    if (!p) throw new PayloadError("Project not found");
    return p;
  }
  async function saveProject(s: ProfileState, p: LabProject) {
    p.updatedAt = now();
    await s.stores.projects.put(p);
    return p;
  }
  async function projectData(s: ProfileState, projectId: string) {
    const [p, questions, evidence, items, decisions] = await Promise.all([
      project(s, projectId),
      s.stores.questions.byProject(projectId),
      s.stores.evidence.byProject(projectId),
      s.stores.extractions.byProject(projectId),
      s.stores.gaps.byProject(projectId),
    ]);
    return { p, questions, evidence, items, decisions };
  }
  async function gapsFor(s: ProfileState, projectId: string, profileId: string) {
    const { p, questions, evidence, items, decisions } = await projectData(s, projectId);
    const hyps = gapHypotheses(p, p.sources, items, questions, evidence, { datedAfterYears: settings(profileId).datedAfterYears });
    const byKey = new Map(decisions.map((d) => [d.key, d]));
    return hyps.map((h) => ({ ...h, decision: byKey.get(h.key)?.status, note: byKey.get(h.key)?.note }));
  }

  /** AI is optional: returns null when the module lacks ai.optional, AI is off, or the user declined. */
  async function runAi(system: string, prompt: string, scope: "selection" | "page" | "pdf" | "references" | "draft") {
    if (!host.ai) return null;
    return host.ai.run({ system, prompt, scope });
  }

  async function storeSuggestions(s: ProfileState, projectId: string, sourceId: string, list: Suggestion[], basis: ExtractionItem["basis"], ai?: ExtractionItem["ai"]) {
    const existing = await s.stores.extractions.byProject(projectId);
    const seen = new Set(existing.filter((e) => e.sourceId === sourceId).map((e) => `${e.field}|${e.quote ?? e.text}`));
    const out: ExtractionItem[] = [];
    for (const sug of list) {
      const k = `${sug.field}|${sug.quote ?? sug.text}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const item: ExtractionItem = { ...entity(), projectId, sourceId, field: sug.field, text: sug.text, labels: sug.labels, quote: sug.quote, origin: sug.origin, status: "suggested", basis, ...(ai ? { ai } : {}) };
      await s.stores.extractions.put(item);
      out.push(item);
    }
    return out;
  }

  const handlers: Record<string, Handler> = {
    // ------------------------------------------------------------ settings & network transparency
    "settings.get": (_p, _s, ctx) => ({
      ...settings(ctx.profileId),
      services: settings(ctx.profileId).services,
      serviceInfo: SERVICE_INFO,
      keys: { openalex: !!secret(`${ctx.profileId}:openalex`), semanticscholar: !!secret(`${ctx.profileId}:semanticscholar`) },
      secretsAvailable: !!host.secrets?.available,
      aiAvailable: !!host.ai,
    }),
    "settings.set": (p, _s, ctx) => {
      const cur = settings(ctx.profileId);
      const services = { ...cur.services };
      if (p.services !== undefined) {
        const sv = obj(p.services, "services");
        for (const k of SERVICES) if (typeof sv[k] === "boolean") services[k] = sv[k] as boolean;
      }
      const mailto = p.mailto !== undefined ? optStr(p, "mailto", 200) : cur.mailto;
      if (mailto && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailto)) throw new PayloadError("Contact email does not look like an email address.");
      const next: LabSettings = {
        ...cur,
        services,
        mailto,
        online: bool(p, "online") ?? cur.online,
        trail: bool(p, "trail") ?? cur.trail,
        datedAfterYears: optInt(p, "datedAfterYears", 1, 100) ?? cur.datedAfterYears,
        trailDays: optInt(p, "trailDays", 1, 365) ?? cur.trailDays,
      };
      host.storage.kv.set("settings", next, ctx.profileId);
      return next;
    },
    "settings.setKey": (p, _s, ctx) => {
      const service = oneOf(p, "service", ["openalex", "semanticscholar"] as const);
      const key = optStr(p, "key", 300);
      if (!host.secrets) throw new PayloadError("Encrypted key storage is not available.");
      if (!key) host.secrets.delete(`${ctx.profileId}:${service}`);
      else {
        if (!host.secrets.available) throw new PayloadError("This system cannot encrypt secrets, so the key was not saved.");
        host.secrets.set(`${ctx.profileId}:${service}`, key.trim());
      }
      return true;
    },
    "net.log": (_p, s) => s.log,
    "net.clearLog": (_p, s) => ((s.log.length = 0), true),

    // ------------------------------------------------------------ discovery
    "discover.search": async (p, s, ctx) => {
      const st = settings(ctx.profileId);
      const requested = p.services ? (strArray(p, "services", 10).filter((x) => SERVICES.includes(x as DiscoveryService)) as DiscoveryService[]) : SERVICES;
      const services = requested.filter((x) => st.services[x]);
      if (!services.length) throw new PayloadError("No search services are enabled. Pick at least one in Research & Writing module settings.");
      const fromYear = optInt(p, "fromYear", 1500, 2200);
      const toYear = optInt(p, "toYear", 1500, 2200);
      const run = await discover(s.net, { text: str(p, "text", 500), fromYear, toYear, limit: optInt(p, "limit", 1, 50), openAccessOnly: bool(p, "openAccessOnly") }, services, cred(ctx.profileId));
      s.searches.unshift(run);
      s.searches.splice(10);
      // Keep recent searches so their results can be reviewed offline.
      if (!ctx.isPrivate) host.storage.kv.set("searches", s.searches, ctx.profileId);
      return run;
    },
    "discover.history": (_p, s) => s.searches,
    "discover.clearHistory": (_p, s, ctx) => {
      s.searches.length = 0;
      host.storage.kv.delete("searches", ctx.profileId);
      return true;
    },

    // ------------------------------------------------------------ projects
    "projects.list": async (p, s) => {
      const ws = optStr(p, "workspaceId", 200);
      const list = await s.stores.projects.list((x) => !ws || !x.workspaceId || x.workspaceId === ws);
      return list.map((x) => ({ id: x.id, title: x.title, description: x.description, workspaceId: x.workspaceId, sources: x.sourceIds.length, counts: screeningCounts(x), updatedAt: x.updatedAt }));
    },
    "projects.get": (p, s) => project(s, id(p, "id")),
    "projects.create": async (p, s) => {
      const proj: LabProject = { ...entity(), title: str(p, "title", 300).trim() || "Untitled review", description: optStr(p, "description", 5000), workspaceId: optStr(p, "workspaceId", 200), sourceIds: [], sources: {}, criteria: structuredClone(DEFAULT_CRITERIA), cells: {}, screening: {} };
      await s.stores.projects.put(proj);
      return proj;
    },
    "projects.update": async (p, s) => {
      const proj = await project(s, id(p, "id"));
      if (p.title !== undefined) proj.title = str(p, "title", 300).trim() || proj.title;
      if (p.description !== undefined) proj.description = optStr(p, "description", 5000);
      if (p.criteria !== undefined) {
        if (!Array.isArray(p.criteria) || p.criteria.length > 40) throw new PayloadError("criteria must be a list of at most 40 columns");
        proj.criteria = p.criteria.map((c) => {
          const o = obj(c, "criterion");
          return { id: optId(o, "id") ?? createId(), label: str(o, "label", 200), field: o.field === undefined || o.field === null ? undefined : oneOf(o, "field", EXTRACTION_FIELDS) };
        });
      }
      return saveProject(s, proj);
    },
    "projects.delete": async (p, s, ctx) => {
      const pid = id(p, "id");
      host.storage.kv.delete(`graph:${pid}`, ctx.profileId);
      await Promise.all([s.stores.questions.deleteProject(pid), s.stores.evidence.deleteProject(pid), s.stores.extractions.deleteProject(pid), s.stores.gaps.deleteProject(pid)]);
      return s.stores.projects.delete(pid);
    },
    /** Add library references to a project (snapshotting their metadata). */
    "projects.addSources": async (p, s) => {
      const proj = await project(s, id(p, "id"));
      for (const r of references(p, "refs", 2000)) {
        if (!proj.sourceIds.includes(r.id)) proj.sourceIds.push(r.id);
        proj.sources[r.id] = r;
      }
      return saveProject(s, proj);
    },
    /** Refresh snapshots from the current library. References missing from the library are reported, not deleted. */
    "projects.syncSources": async (p, s) => {
      const proj = await project(s, id(p, "id"));
      const lib = new Map(references(p, "refs", 50_000).map((r) => [r.id, r]));
      const missing: string[] = [];
      for (const sid of proj.sourceIds) {
        const r = lib.get(sid);
        if (r) proj.sources[sid] = r;
        else missing.push(sid);
      }
      await saveProject(s, proj);
      return { project: proj, missing };
    },
    "projects.removeSource": async (p, s) => {
      const proj = await project(s, id(p, "id"));
      const sid = id(p, "sourceId");
      proj.sourceIds = proj.sourceIds.filter((x) => x !== sid);
      delete proj.sources[sid];
      delete proj.cells[sid];
      delete proj.screening[sid];
      for (const e of await s.stores.extractions.byProject(proj.id)) if (e.sourceId === sid) await s.stores.extractions.delete(e.id);
      for (const e of await s.stores.evidence.byProject(proj.id)) if (e.sourceId === sid) await s.stores.evidence.delete(e.id);
      return saveProject(s, proj);
    },
    "projects.screen": async (p, s) => {
      const proj = await project(s, id(p, "id"));
      const sid = id(p, "sourceId");
      if (!proj.sourceIds.includes(sid)) throw new PayloadError("That source is not in this project.");
      if (p.status === null) delete proj.screening[sid];
      else {
        const criteria = strArray(p, "criteria", 20, 500);
        const known = new Set([...(proj.scope?.inclusion ?? []), ...(proj.scope?.exclusion ?? [])]);
        if (criteria.some((c) => !known.has(c))) throw new PayloadError("Unknown screening criterion; add it to the project scope first.");
        proj.screening[sid] = { status: oneOf(p, "status", ["include", "exclude", "maybe"] as const), reason: optStr(p, "reason", 1000), criteria: criteria.length ? criteria : undefined, at: now() };
      }
      return saveProject(s, proj);
    },
    "projects.setCell": async (p, s) => {
      const proj = await project(s, id(p, "id"));
      const sid = id(p, "sourceId");
      const cid = id(p, "criterionId");
      if (!proj.criteria.some((c) => c.id === cid)) throw new PayloadError("Unknown column");
      const text = str(p, "text", 5000);
      proj.cells[sid] ??= {};
      if (!text.trim()) delete proj.cells[sid]![cid];
      else proj.cells[sid]![cid] = { text, origin: "manual", at: now() };
      return saveProject(s, proj);
    },
    /** Whole project as one JSON file (the module's project file format). */
    "projects.export": async (p, s) => {
      const { p: proj, questions, evidence, items, decisions } = await projectData(s, id(p, "id"));
      return JSON.stringify({ format: "aether-research-project", version: 1, exportedAt: now(), project: proj, questions, evidence, extractions: items, gapDecisions: decisions }, null, 2);
    },
    "projects.import": async (p, s, ctx) => {
      const text = str(p, "text", 50_000_000);
      let data: Obj;
      try {
        data = obj(JSON.parse(text), "file");
      } catch (e) {
        throw new PayloadError(e instanceof PayloadError ? e.message : "Not a valid project file.");
      }
      if (data.format !== "aether-research-project") throw new PayloadError("Not an AETHER research project file.");
      const src = obj(data.project, "project");
      const newId = createId();
      const proj: LabProject = {
        ...entity(),
        id: newId,
        title: `${str(src, "title", 300)} (imported)`,
        description: optStr(src, "description", 5000),
        workspaceId: optStr(p, "workspaceId", 200),
        sourceIds: [...new Set(strArray(src, "sourceIds", 5000, 200).map((x) => id({ x }, "x")))],
        // Keys must equal each reference's own (validated) id.
        sources: Object.fromEntries(Object.values(obj(src.sources ?? {}, "sources")).slice(0, 5000).map((v) => { const r = reference(v); return [r.id, r]; })),
        criteria: Array.isArray(src.criteria) ? src.criteria.slice(0, 40).map((c) => { const o = obj(c); return { id: id(o, "id"), label: str(o, "label", 200), field: o.field ? oneOf(o, "field", EXTRACTION_FIELDS) : undefined }; }) : structuredClone(DEFAULT_CRITERIA),
        cells: {},
        screening: {},
        scope: src.scope ? (() => { const sc = obj(src.scope, "scope"); return { statement: optStr(sc, "statement", 5000), inclusion: strArray(sc, "inclusion", 50, 500), exclusion: strArray(sc, "exclusion", 50, 500), fromYear: optInt(sc, "fromYear", 1500, 2200), toYear: optInt(sc, "toYear", 1500, 2200) }; })() : undefined,
      };
      for (const [sid, row] of Object.entries(obj(src.cells ?? {}, "cells")).slice(0, 5000)) {
        id({ sid }, "sid");
        for (const [cid, cell] of Object.entries(obj(row)).slice(0, 40)) {
          id({ cid }, "cid");
          const c = obj(cell);
          (proj.cells[sid] ??= {})[cid] = { text: str(c, "text", 5000), origin: "manual", at: optStr(c, "at", 40) ?? now() };
        }
      }
      for (const [sid, d] of Object.entries(obj(src.screening ?? {}, "screening")).slice(0, 5000)) {
        id({ sid }, "sid");
        const o = obj(d);
        proj.screening[sid] = { status: oneOf(o, "status", ["include", "exclude", "maybe"] as const), reason: optStr(o, "reason", 1000), criteria: o.criteria ? strArray(o, "criteria", 20, 500) : undefined, at: optStr(o, "at", 40) ?? now() };
      }
      // Re-key child records so an import never overwrites existing data.
      const idMap = new Map<string, string>();
      const remap = (old: unknown) => {
        const k = String(old);
        if (!idMap.has(k)) idMap.set(k, createId());
        return idMap.get(k)!;
      };
      const list = (k: string) => (Array.isArray(data[k]) ? (data[k] as unknown[]).slice(0, 20_000).map((x) => obj(x)) : []);
      for (const q of list("questions")) await s.stores.questions.put({ ...entity(), id: remap(q.id), projectId: newId, text: str(q, "text", 2000), parentId: q.parentId ? remap(q.parentId) : undefined, status: oneOf(q, "status", ["open", "investigating", "answered", "parked"] as const, "open"), notes: optStr(q, "notes", 20_000), order: optInt(q, "order", 0, 1e6) ?? 0 });
      for (const it of list("extractions")) await s.stores.extractions.put({ ...entity(), id: remap(it.id), projectId: newId, sourceId: id(it, "sourceId"), field: oneOf(it, "field", EXTRACTION_FIELDS), text: str(it, "text", 5000), labels: strArray(it, "labels", 10, 60), quote: optStr(it, "quote", 5000), origin: oneOf(it, "origin", ["manual", "heuristic", "ai"] as const, "manual"), status: oneOf(it, "status", ["suggested", "accepted", "rejected"] as const, "suggested"), locator: it.locator ? locator(it.locator) : undefined });
      for (const e of list("evidence")) await s.stores.evidence.put({ ...entity(), id: remap(e.id), projectId: newId, questionId: remap(e.questionId), sourceId: id(e, "sourceId"), stance: oneOf(e, "stance", ["supports", "contradicts", "mixed", "context"] as const), claim: str(e, "claim", 5000), quote: optStr(e, "quote", 5000), origin: oneOf(e, "origin", ["manual", "heuristic", "ai"] as const, "manual"), locator: e.locator ? locator(e.locator) : undefined, extractionId: e.extractionId ? remap(e.extractionId) : undefined });
      for (const g of list("gapDecisions")) await s.stores.gaps.put({ ...entity(), projectId: newId, key: str(g, "key", 500), status: oneOf(g, "status", ["kept", "dismissed"] as const), note: optStr(g, "note", 5000) });
      await s.stores.projects.put(proj);
      void ctx;
      return proj;
    },

    "projects.setScope": async (p, s) => {
      const proj = await project(s, id(p, "id"));
      proj.scope = { statement: optStr(p, "statement", 5000), inclusion: strArray(p, "inclusion", 50, 500).map((x) => x.trim()).filter(Boolean), exclusion: strArray(p, "exclusion", 50, 500).map((x) => x.trim()).filter(Boolean), fromYear: optInt(p, "fromYear", 1500, 2200), toYear: optInt(p, "toYear", 1500, 2200) };
      return saveProject(s, proj);
    },
    "projects.report": async (p, s, ctx) => {
      const { p: proj, questions, evidence, items } = await projectData(s, id(p, "id"));
      const kept = (await gapsFor(s, proj.id, ctx.profileId)).filter((g) => g.decision === "kept");
      const outline = buildOutline(proj, proj.sources, questions, evidence, items, kept);
      return { markdown: reviewReport(proj, questions, items, outline, kept), references: proj.sourceIds.filter((x) => proj.screening[x]?.status !== "exclude").map((k) => proj.sources[k]).filter((r): r is Reference => !!r) };
    },
    "projects.benchmarks": async (p, s) => {
      const { p: proj, items } = await projectData(s, id(p, "id"));
      return benchmarkTable(items.filter((i) => proj.screening[i.sourceId]?.status !== "exclude"));
    },
    /** Which project sources mention a term (titles, abstracts, accepted extractions). Offline. */
    "projects.searchTerm": async (p, s) => {
      const { p: proj, items } = await projectData(s, id(p, "id"));
      return sourcesMentioning(str(p, "term", 200), proj.sources, items);
    },
    "projects.timeline": async (p, s) => projectTimeline(Object.values((await project(s, id(p, "id"))).sources)),
    /** Citation graph + related-paper suggestions (OpenAlex). Cached per project for offline viewing. */
    "projects.graph": async (p, s, ctx) => {
      const proj = await project(s, id(p, "id"));
      const key = `graph:${proj.id}`;
      if (p.cached === true) return host.storage.kv.get(key, ctx.profileId) ?? null;
      const included = proj.sourceIds.filter((x) => proj.screening[x]?.status !== "exclude").map((x) => proj.sources[x]).filter((r): r is Reference => !!r);
      const g = await citationGraph(s.net, included, cred(ctx.profileId), { label: (r) => sourceLabel(r, r.id) });
      if (!ctx.isPrivate) host.storage.kv.set(key, g, ctx.profileId);
      return g;
    },
    "discover.timeline": (p, s, ctx) => topicTimeline(s.net, str(p, "text", 300), cred(ctx.profileId)),
    "discover.scholarLink": (p) => googleScholarUrl(str(p, "text", 500)),

    // ------------------------------------------------------------ reading queue and tags (library-wide)
    "reading.list": async (p, s) => {
      const status = p.status ? oneOf(p, "status", ["queued", "reading", "read", "skipped"] as const) : undefined;
      return (await s.stores.reading.list((r) => !status || r.status === status)).sort((a, b) => a.position - b.position);
    },
    "reading.set": async (p, s) => {
      const refId = id(p, "refId");
      const cur = await s.stores.reading.get(refId);
      const all = cur ? [] : await s.stores.reading.list();
      const tags: ReadingItem["tags"] = { ...(cur?.tags ?? {}) };
      if (p.tags !== undefined) {
        const t = obj(p.tags, "tags");
        for (const f of TAG_FACETS) if (t[f] !== undefined) tags[f] = strArray(t, f, 30, 80).map((x) => x.trim()).filter(Boolean);
      }
      const item: ReadingItem = {
        id: refId,
        refId,
        createdAt: cur?.createdAt ?? now(),
        updatedAt: now(),
        status: p.status !== undefined ? oneOf(p, "status", ["queued", "reading", "read", "skipped"] as const) : (cur?.status ?? "queued"),
        tags,
        relevance: p.relevance !== undefined ? ((optInt(p, "relevance", 0, 3) ?? 0) as ReadingItem["relevance"]) : (cur?.relevance ?? 0),
        note: p.note !== undefined ? optStr(p, "note", 20_000) : cur?.note,
        title: p.title !== undefined ? optStr(p, "title", 500) : cur?.title,
        position: optInt(p, "position", 0, 1e7) ?? cur?.position ?? all.length,
      };
      await s.stores.reading.put(item);
      return item;
    },
    "reading.delete": (p, s) => s.stores.reading.delete(id(p, "refId")),
    /** Tag counts per facet, for the topic-library sidebar. */
    "reading.facets": async (_p, s) => {
      const out: Record<string, Record<string, number>> = {};
      for (const r of await s.stores.reading.list()) for (const f of TAG_FACETS) for (const t of r.tags[f] ?? []) ((out[f] ??= {})[t] = (out[f]![t] ?? 0) + 1);
      return out;
    },

    // ------------------------------------------------------------ Writing Intelligence (called by the Writer)
    /**
     * Check a document's citations: unknown keys, never-cited references,
     * uncited claims, and a per-citation support check against what this
     * module holds for each source. `refs` comes from the shared library.
     */
    "writing.checkCitations": async (p, s, ctx) => {
      const markdown = str(p, "markdown", MAX_TEXT);
      const refs = new Map(references(p, "refs", 50_000).map((r) => [r.id, r]));
      const [items, evidence, saved] = await Promise.all([s.stores.extractions.list((i) => i.status === "accepted"), s.stores.evidence.list(), s.stores.saved.list((x) => !!x.refId)]);
      const material = (key: string) => ({
        abstract: refs.get(key)?.abstract,
        extractions: items.filter((i) => i.sourceId === key),
        evidence: evidence.filter((e) => e.sourceId === key),
        savedText: saved.filter((x) => x.refId === key).map((x) => x.text).join("\n"),
      });
      const report = checkCitations(markdown, refs, material, { attachedIds: strArray(p, "attachedIds", 50_000, 200) });
      if (p.useAi === true && host.ai) {
        // Second opinion only for citations the lexical check flags, capped to keep requests small.
        for (const c of report.checks.filter((x) => x.verdict === "weak" || x.verdict === "numbers-missing").slice(0, 10)) {
          const m = material(c.key);
          const text = [m.abstract ?? "", ...m.extractions.map((e) => `${e.text} ${e.quote ?? ""}`), ...m.evidence.map((e) => `${e.claim} ${e.quote ?? ""}`), m.savedText ?? ""].join("\n");
          const { system, prompt } = supportPrompt(c.sentence, text);
          const r = await runAi(system, prompt, "draft");
          if (r) (c as typeof c & { ai?: unknown }).ai = parseSupport(r.text, text);
        }
      }
      void ctx;
      return report;
    },

    // ------------------------------------------------------------ research questions
    "questions.list": (p, s) => s.stores.questions.byProject(id(p, "projectId")).then((l) => l.sort((a, b) => a.order - b.order)),
    "questions.create": async (p, s) => {
      const projectId = id(p, "projectId");
      await project(s, projectId);
      const existing = await s.stores.questions.byProject(projectId);
      const q: ResearchQuestion = { ...entity(), projectId, text: str(p, "text", 2000).trim(), parentId: optId(p, "parentId"), status: "open", notes: optStr(p, "notes", 20_000), order: existing.length };
      if (!q.text) throw new PayloadError("Write the question first.");
      await s.stores.questions.put(q);
      return q;
    },
    "questions.update": async (p, s) => {
      const q = await s.stores.questions.get(id(p, "id"));
      if (!q) throw new PayloadError("Question not found");
      if (p.text !== undefined) q.text = str(p, "text", 2000);
      if (p.status !== undefined) q.status = oneOf(p, "status", ["open", "investigating", "answered", "parked"] as const);
      if (p.notes !== undefined) q.notes = optStr(p, "notes", 20_000);
      if (p.order !== undefined) q.order = optInt(p, "order", 0, 1e6) ?? q.order;
      q.updatedAt = now();
      await s.stores.questions.put(q);
      return q;
    },
    "questions.refine": async (p, s) => {
      const q = await s.stores.questions.get(id(p, "id"));
      if (!q) throw new PayloadError("Question not found");
      const checklist = refineQuestion(q.text);
      let suggestions: string[] = [];
      if (p.useAi === true) {
        const proj = await project(s, q.projectId);
        const { system, prompt } = refinePrompt(q.text, proj.scope?.statement ?? proj.description);
        const r = await runAi(system, prompt, "selection");
        if (r) suggestions = r.text.split("\n").map((l) => l.replace(/^\s*[-*\d.]+\s*/, "").trim()).filter((l) => l.length > 10).slice(0, 3);
      }
      return { checklist, suggestions, aiUsed: suggestions.length > 0 };
    },
    "questions.delete": async (p, s) => {
      const qid = id(p, "id");
      const q = await s.stores.questions.get(qid);
      if (!q) return false;
      for (const e of await s.stores.evidence.byProject(q.projectId)) if (e.questionId === qid) await s.stores.evidence.delete(e.id);
      for (const c of await s.stores.questions.byProject(q.projectId)) if (c.parentId === qid) await s.stores.questions.put({ ...c, parentId: undefined, updatedAt: now() });
      return s.stores.questions.delete(qid);
    },

    // ------------------------------------------------------------ evidence
    "evidence.list": (p, s) => s.stores.evidence.byProject(id(p, "projectId")),
    "evidence.create": async (p, s) => {
      const projectId = id(p, "projectId");
      const proj = await project(s, projectId);
      const questionId = id(p, "questionId");
      const q = await s.stores.questions.get(questionId);
      if (!q || q.projectId !== projectId) throw new PayloadError("Question not found in this project");
      const sourceId = id(p, "sourceId");
      if (!proj.sourceIds.includes(sourceId)) throw new PayloadError("Add the source to the project first: evidence must come from a source in your library.");
      const extractionId = optId(p, "extractionId");
      let quote = optStr(p, "quote", 5000);
      if (extractionId) {
        const it = await s.stores.extractions.get(extractionId);
        if (!it || it.sourceId !== sourceId) throw new PayloadError("That extraction belongs to another source.");
        quote ??= it.quote;
      }
      const e: Evidence = { ...entity(), projectId, questionId, sourceId, stance: oneOf(p, "stance", ["supports", "contradicts", "mixed", "context"] as const), claim: str(p, "claim", 5000).trim(), quote, locator: p.locator ? locator(p.locator) : undefined, extractionId, origin: "manual" };
      if (!e.claim) throw new PayloadError("Describe what the source says.");
      await s.stores.evidence.put(e);
      return e;
    },
    "evidence.update": async (p, s) => {
      const e = await s.stores.evidence.get(id(p, "id"));
      if (!e) throw new PayloadError("Evidence not found");
      if (p.claim !== undefined) e.claim = str(p, "claim", 5000);
      if (p.stance !== undefined) e.stance = oneOf(p, "stance", ["supports", "contradicts", "mixed", "context"] as const);
      if (p.quote !== undefined) e.quote = optStr(p, "quote", 5000);
      if (p.locator !== undefined) e.locator = p.locator ? locator(p.locator) : undefined;
      e.updatedAt = now();
      await s.stores.evidence.put(e);
      return e;
    },
    "evidence.delete": (p, s) => s.stores.evidence.delete(id(p, "id")),

    // ------------------------------------------------------------ extraction
    "extract.list": async (p, s) => {
      const sid = optId(p, "sourceId");
      return (await s.stores.extractions.byProject(id(p, "projectId"))).filter((i) => !sid || i.sourceId === sid);
    },
    "extract.create": async (p, s) => {
      const projectId = id(p, "projectId");
      const proj = await project(s, projectId);
      const sourceId = id(p, "sourceId");
      if (!proj.sourceIds.includes(sourceId)) throw new PayloadError("That source is not in this project.");
      const item: ExtractionItem = { ...entity(), projectId, sourceId, field: oneOf(p, "field", EXTRACTION_FIELDS), text: str(p, "text", 5000).trim(), labels: strArray(p, "labels", 10, 60), quote: optStr(p, "quote", 5000), locator: p.locator ? locator(p.locator) : undefined, origin: "manual", status: "accepted" };
      if (!item.text) throw new PayloadError("Write the extracted point first.");
      await s.stores.extractions.put(item);
      return item;
    },
    "extract.update": async (p, s) => {
      const it = await s.stores.extractions.get(id(p, "id"));
      if (!it) throw new PayloadError("Extraction not found");
      if (p.status !== undefined) it.status = oneOf(p, "status", ["suggested", "accepted", "rejected"] as const);
      if (p.field !== undefined) it.field = oneOf(p, "field", EXTRACTION_FIELDS);
      if (p.text !== undefined) {
        const t = str(p, "text", 5000);
        // Editing a suggestion makes it the user's own wording; the quote stays as provenance.
        if (t !== it.text && it.origin !== "manual") it.status = "accepted";
        it.text = t;
      }
      if (p.labels !== undefined) it.labels = strArray(p, "labels", 10, 60);
      if (p.locator !== undefined) it.locator = p.locator ? locator(p.locator) : undefined;
      it.updatedAt = now();
      await s.stores.extractions.put(it);
      return it;
    },
    "extract.delete": (p, s) => s.stores.extractions.delete(id(p, "id")),
    /**
     * Suggest extraction items for one source from text: the abstract in the
     * snapshot, text the user pasted, or the active tab (needs tabs.read).
     * The heuristic always runs; AI runs only if asked and available.
     */
    "extract.suggest": async (p, s, ctx) => {
      const projectId = id(p, "projectId");
      const proj = await project(s, projectId);
      const sourceId = id(p, "sourceId");
      const ref = proj.sources[sourceId];
      if (!ref) throw new PayloadError("That source is not in this project.");
      const from = oneOf(p, "from", ["abstract", "supplied-text", "page"] as const, "abstract");
      let text = "";
      if (from === "abstract") text = ref.abstract ?? "";
      else if (from === "supplied-text") text = str(p, "text", MAX_TEXT);
      else {
        const tab = host.tabs.getActive(ctx.windowId);
        const page = tab ? await host.tabs.getPageContent(tab.tabId) : null;
        if (!page) throw new PayloadError("This page cannot be read.");
        text = page.text.slice(0, MAX_TEXT);
      }
      if (text.trim().length < 40) throw new PayloadError(from === "abstract" ? "This source has no abstract. Paste text from the paper, or open it in a tab." : "Not enough text to extract from.");
      const heuristic = heuristicSuggestions(text);
      const created = await storeSuggestions(s, projectId, sourceId, heuristic, from === "page" ? "page" : from);
      let ai: { used: boolean; added: number; rejected: Array<{ reason: string; text?: string }>; message?: string } = { used: false, added: 0, rejected: [] };
      if (p.useAi === true) {
        const { system, prompt } = extractionPrompt(text, ref.title);
        const r = await runAi(system, prompt, from === "page" ? "page" : from === "abstract" ? "references" : "selection");
        if (!r) ai = { used: false, added: 0, rejected: [], message: "AI is off or was not allowed for this content. Heuristic suggestions only." };
        else {
          const parsed = parseAiSuggestions(r.text, text);
          const added = await storeSuggestions(s, projectId, sourceId, parsed.accepted, from === "page" ? "page" : from, { provider: "host", model: "configured" });
          created.push(...added);
          ai = { used: true, added: added.length, rejected: parsed.rejected };
        }
      }
      return { created, ai };
    },

    // ------------------------------------------------------------ matrix, gaps, outline
    "matrix.get": async (p, s) => {
      const { p: proj, items } = await projectData(s, id(p, "projectId"));
      return buildMatrix(proj, proj.sources, items);
    },
    "matrix.export": async (p, s) => {
      const { p: proj, items } = await projectData(s, id(p, "projectId"));
      const m = buildMatrix(proj, proj.sources, items);
      return oneOf(p, "format", ["csv", "markdown"] as const) === "csv" ? matrixToCsv(m) : matrixToMarkdown(m);
    },
    "gaps.list": (p, s, ctx) => gapsFor(s, id(p, "projectId"), ctx.profileId),
    "gaps.decide": async (p, s) => {
      const projectId = id(p, "projectId");
      const key = str(p, "key", 500);
      const existing = (await s.stores.gaps.byProject(projectId)).find((d) => d.key === key);
      if (p.status === null) {
        if (existing) await s.stores.gaps.delete(existing.id);
        return true;
      }
      const d: GapDecision = { ...(existing ?? entity()), projectId, key, status: oneOf(p, "status", ["kept", "dismissed"] as const), note: optStr(p, "note", 5000), updatedAt: now() };
      await s.stores.gaps.put(d);
      return d;
    },
    "outline.get": async (p, s, ctx) => {
      const { p: proj, questions, evidence, items } = await projectData(s, id(p, "projectId"));
      const kept = (await gapsFor(s, proj.id, ctx.profileId)).filter((g) => g.decision === "kept");
      const outline = buildOutline(proj, proj.sources, questions, evidence, items, kept);
      return { outline, markdown: outlineToMarkdown(outline), references: outline.citedKeys.map((k) => proj.sources[k]).filter((r): r is Reference => !!r) };
    },

    // ------------------------------------------------------------ verification & quality
    /** Verify references (sent by the UI from the shared library). Results are stored per reference id. */
    "verify.run": async (p, s, ctx) => {
      const refs = references(p, "refs", 500);
      const out: VerificationRecord[] = [];
      for (const r of refs) {
        const rec = await verifyReference(s.net, r, { cred: cred(ctx.profileId), checkRetractions: p.checkRetractions !== false });
        if (rec.status !== "offline") await s.stores.verifications.put(rec);
        out.push(rec);
        host.ipc.emit("verify.progress", { done: out.length, total: refs.length, refId: r.id, status: rec.status }, ctx.windowId);
        if (rec.status === "offline") break;
      }
      return out;
    },
    "verify.list": async (p, s) => {
      const ids = strArray(p, "refIds", 50_000, 200);
      return s.stores.verifications.list((v) => !ids.length || ids.includes(v.refId));
    },
    "verify.clear": (_p, s) => s.stores.verifications.clear(),
    /** Returns the user's reference with the chosen registry fields applied. The UI saves it to the library. */
    "verify.corrected": async (p, s) => {
      const ref = reference(p.ref);
      const rec = await s.stores.verifications.get(ref.id);
      if (!rec?.candidate) throw new PayloadError("No registry record to take corrections from. Verify the reference first.");
      const fields = strArray(p, "fields", 10).filter((f): f is "title" | "author" | "issued" | "container-title" | "DOI" | "volume" | "page" => ["title", "author", "issued", "container-title", "DOI", "volume", "page"].includes(f));
      return applyCorrections(ref, rec.candidate, fields);
    },
    "quality.report": async (p, s, ctx) => {
      const refs = references(p, "refs", 50_000);
      const ver = new Map((await s.stores.verifications.list()).map((v) => [v.refId, v]));
      const md = optStr(p, "markdown", MAX_TEXT);
      return qualityReport(refs, ver, { datedAfterYears: settings(ctx.profileId).datedAfterYears, citedKeys: md ? citedKeys(md) : undefined });
    },

    // ------------------------------------------------------------ offline saved pages
    "saved.add": async (p, s, ctx) => {
      if (ctx.isPrivate) throw new PayloadError("Pages are not saved from private windows.");
      const tab = host.tabs.getActive(ctx.windowId);
      if (!tab || !/^https?:/i.test(tab.url)) throw new PayloadError("Open a web page first.");
      const page = await host.tabs.getPageContent(tab.tabId);
      if (!page) throw new PayloadError("This page cannot be read (internal or blocked page).");
      const rec: SavedPage = { ...entity(), url: safeUrl(page.url) ?? tab.url, title: (page.title || tab.title || page.url).slice(0, 500), text: page.text.slice(0, MAX_TEXT), workspaceId: tab.workspaceId ?? undefined, dois: page.dois.slice(0, 20), tags: strArray(p, "tags", 20, 60), refId: optId(p, "refId") };
      if (host.tabs.savePage) {
        const dir = join(host.dataDir, "pages");
        await mkdir(dir, { recursive: true });
        const file = `${rec.id}.mhtml`;
        try {
          if (await host.tabs.savePage(tab.tabId, join(dir, file))) {
            rec.archive = file;
            rec.bytes = (await stat(join(dir, file))).size;
          }
        } catch (e) {
          host.log.warn("savePage failed", e);
        }
      }
      await s.stores.saved.put(rec);
      return { ...rec, text: undefined, chars: rec.text.length };
    },
    "saved.list": async (p, s) => {
      const ws = optStr(p, "workspaceId", 200);
      return (await s.stores.saved.list((x) => !ws || !x.workspaceId || x.workspaceId === ws)).map(({ text, ...rest }) => ({ ...rest, chars: text.length }));
    },
    "saved.search": async (p, s) => searchSaved(await s.stores.saved.list(), str(p, "query", 500), optInt(p, "limit", 1, 200) ?? 50),
    "saved.get": async (p, s) => {
      const rec = await s.stores.saved.get(id(p, "id"));
      if (!rec) throw new PayloadError("Saved page not found");
      return rec;
    },
    "saved.update": async (p, s) => {
      const rec = await s.stores.saved.get(id(p, "id"));
      if (!rec) throw new PayloadError("Saved page not found");
      if (p.tags !== undefined) rec.tags = strArray(p, "tags", 20, 60);
      if (p.refId !== undefined) rec.refId = optId(p, "refId");
      rec.updatedAt = now();
      await s.stores.saved.put(rec);
      return true;
    },
    /** Archive bytes for "Download archive" (MHTML is text). */
    "saved.archive": async (p, s) => {
      const rec = await s.stores.saved.get(id(p, "id"));
      if (!rec?.archive) throw new PayloadError("No archive file for this page; only its text was saved.");
      if (!/^[\w-]+\.mhtml$/.test(rec.archive)) throw new PayloadError("Invalid archive name");
      return { name: `${rec.title.replace(/[^\w\- ]+/g, "").slice(0, 80) || "page"}.mhtml`, content: await readFile(join(host.dataDir, "pages", rec.archive), "utf8") };
    },
    "saved.delete": async (p, s) => {
      const rec = await s.stores.saved.get(id(p, "id"));
      if (!rec) return false;
      if (rec.archive && /^[\w-]+\.mhtml$/.test(rec.archive)) await rm(join(host.dataDir, "pages", rec.archive), { force: true });
      return s.stores.saved.delete(rec.id);
    },

    // ------------------------------------------------------------ research trail (opt-in)
    "trail.list": async (p, s) => {
      const ws = optStr(p, "workspaceId", 200);
      const q = optStr(p, "query", 200)?.toLowerCase();
      const list = await s.stores.trail.list((t) => (!ws || t.workspaceId === ws) && (!q || `${t.title} ${t.url}`.toLowerCase().includes(q)));
      return list.sort((a, b) => b.lastVisit.localeCompare(a.lastVisit)).slice(0, optInt(p, "limit", 1, 5000) ?? 500);
    },
    "trail.delete": (p, s) => s.stores.trail.delete(id(p, "id")),
    "trail.clear": (_p, s) => s.stores.trail.clear(),
  };

  function locator(v: unknown) {
    const o = obj(v, "locator");
    return { page: optInt(o, "page", 1, 100_000), annotationId: optId(o, "annotationId"), label: optStr(o, "label", 100) };
  }

  /** Trail recording: only when the user enabled it, never for private windows, only http(s), no query strings or fragments. */
  async function recordVisit(t: { url: string; title: string; profileId: string; workspaceId: string | null; isPrivate: boolean }) {
    if (t.isPrivate || !settings(t.profileId).trail) return;
    let url: URL;
    try {
      url = new URL(t.url);
    } catch {
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
    // Drop query and fragment: they often hold search terms, session tokens or personal data.
    const clean = `${url.origin}${url.pathname}`;
    const s = state(t.profileId);
    const key = `v_${hash(clean + "|" + (t.workspaceId ?? ""))}`;
    const cur = await s.stores.trail.get(key);
    const at = now();
    const entry: TrailEntry = cur ? { ...cur, title: t.title.slice(0, 500) || cur.title, visits: cur.visits + 1, lastVisit: at, updatedAt: at } : { id: key, createdAt: at, updatedAt: at, url: clean, title: t.title.slice(0, 500) || clean, workspaceId: t.workspaceId ?? undefined, visits: 1, lastVisit: at };
    await s.stores.trail.put(entry);
  }

  async function pruneTrail(profileId: string) {
    const days = settings(profileId).trailDays;
    await state(profileId).stores.trail.deleteOlderThan(new Date(Date.now() - days * 86_400_000).toISOString());
  }

  return {
    id: MODULE_ID,
    state,
    activate(h) {
      host = h;
      h.storage.migrate(MODULE_MIGRATIONS);
      for (const [method, fn] of Object.entries(handlers)) {
        h.ipc.handle(method, async (payload, ctx) => {
          const p = payload === undefined || payload === null ? {} : obj(payload);
          try {
            return await fn(p, state(ctx.profileId, ctx.isPrivate), ctx);
          } catch (e) {
            if (!(e instanceof PayloadError) && (e as Error).name !== "NetError") h.log.error(`${method} failed`, e);
            throw e;
          }
        });
      }
      unsubs.push(
        h.events.on("tabNavigated", (t) => {
          if (t.inPage) return;
          trailQueue = trailQueue.then(() => recordVisit(t)).catch((e) => h.log.warn("trail", e));
        }),
        h.events.on("profileDeleted", ({ profileId }) => {
          const projIds = (h.storage.db.prepare("SELECT id FROM module_research_docs WHERE collection = 'projects' AND profile_id = ?").all(profileId) as Array<{ id: string }>).map((r) => r.id);
          for (const pid of projIds) h.storage.kv.delete(`graph:${pid}`, profileId);
          const n = deleteProfile(h.storage.db, profileId);
          persistent.delete(profileId);
          ephemeral.delete(profileId);
          for (const k of ["settings", "searches"]) h.storage.kv.delete(k, profileId);
          for (const k of ["openalex", "semanticscholar"]) h.secrets?.delete(`${profileId}:${k}`);
          h.log.info(`Deleted ${n} Research & Writing module records for profile ${profileId}`);
        }),
      );
      // Prune the trail at start-up for known profiles.
      for (const prof of h.profiles?.list?.() ?? []) void pruneTrail(prof.id).catch(() => undefined);
    },
    deactivate() {
      for (const u of unsubs.splice(0)) u();
      persistent.clear();
      ephemeral.clear();
    },
  };
}

function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
