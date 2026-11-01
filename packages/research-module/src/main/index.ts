import type { AetherMainModule, MainHost, SqlDatabase } from "@aether/plugin-api";
import { MemoryCollection, type Collection, type Entity } from "@aether/research-core";
import { Bibliography, exportBibtex, generateKey, importBibtex, importRis, exportRis, validateReference, findDuplicates, type Reference, type StyleId } from "@aether/citations";
import { captureSource, lookupIdentifier, type FetchLike as SourceFetch } from "@aether/sources";
import { Notebook, type Note } from "@aether/notebook";
import { AnnotationStore, annotationsToMarkdown, type Annotation, type HighlightColor } from "@aether/annotations";
import { PaperStore, checkPaper, exportHtml, exportLatex, exportMarkdown, exportPandoc, type Paper } from "@aether/paper-editor";
import { AiError, AiGateway, AnthropicProvider, OllamaProvider, OpenAICompatibleProvider, explainTask, reviseTask, summarizeTask, claimCheckTask, outlineTask, type DataScope, type FetchLike as AiFetch, type GatewayState } from "@aether/ai";
import { RESEARCH_MIGRATIONS, SqliteCollection, deleteProfileData } from "./sqlite-collection.js";
import { PayloadError, int, obj, oneOf, optStr, str, strArray } from "./validate.js";

export { MODULE_ID } from "./constants.js";
import { MODULE_ID } from "./constants.js";

/** A reference in the user's library, wrapped with library metadata. */
export interface LibraryItem extends Entity {
  ref: Reference;
  workspaceId?: string;
  tags: string[];
  pdfUrl?: string;
  provenance: string[];
}

export interface ResearchSettings {
  /** Allow DOI/arXiv lookups (sends the identifier to Crossref/arXiv). Off by default. */
  onlineLookups: boolean;
  /** Optional contact email for Crossref's polite pool. */
  crossrefMailto?: string;
  defaultStyle: StyleId;
}

const DEFAULT_SETTINGS: ResearchSettings = { onlineLookups: false, defaultStyle: "ieee" };

interface ProfileServices {
  notes: Notebook;
  library: Collection<LibraryItem>;
  annotations: AnnotationStore;
  papers: PaperStore;
  ai: AiGateway;
}

/** Optional OS-keychain storage (Electron safeStorage). If the shell lacks it, API keys stay in memory only. */
interface SecretStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export function createResearchModule(): AetherMainModule & { services(profileId: string, isPrivate?: boolean): ProfileServices } {
  let host: MainHost;
  let db: SqlDatabase;
  const persistent = new Map<string, ProfileServices>();
  const ephemeral = new Map<string, ProfileServices>();
  const memorySecrets = new Map<string, string>();

  const secrets = (): SecretStore => {
    const s = (host as unknown as { secrets?: SecretStore }).secrets;
    return s ?? { get: (k) => memorySecrets.get(k), set: (k, v) => void memorySecrets.set(k, v), delete: (k) => void memorySecrets.delete(k) };
  };

  const settings = (profileId: string): ResearchSettings => ({ ...DEFAULT_SETTINGS, ...(host.storage.kv.get<ResearchSettings>("settings", profileId) ?? {}) });

  const netFetch = ((url: string, init?: { headers?: Record<string, string>; method?: string; body?: string; signal?: AbortSignal }) => host.net.fetch(url, init as RequestInit)) as unknown as SourceFetch & AiFetch;

  function services(profileId: string, isPrivate = false): ProfileServices {
    const cache = isPrivate ? ephemeral : persistent;
    let s = cache.get(profileId);
    if (s) return s;
    // Private windows keep research data in memory only; nothing touches disk.
    const coll = <T extends Entity>(name: string): Collection<T> => (isPrivate ? new MemoryCollection<T>() : new SqliteCollection<T & { workspaceId?: string }>(db, name, profileId));
    const aiState = isPrivate ? undefined : host.storage.kv.get<GatewayState>("ai", profileId);
    const ai = new AiGateway(aiState);
    s = {
      notes: new Notebook(coll<Note>("notes")),
      library: coll<LibraryItem>("library"),
      annotations: new AnnotationStore(coll<Annotation>("annotations")),
      papers: new PaperStore(coll<Paper>("papers")),
      ai,
    };
    if (!isPrivate) {
      const save = () => host.storage.kv.set("ai", ai.snapshot(), profileId);
      ai.events.on(save);
    }
    restoreProviders(profileId, ai);
    cache.set(profileId, s);
    return s;
  }

  function restoreProviders(profileId: string, ai: AiGateway) {
    const cfg = host.storage.kv.get<ProviderConfig[]>("ai-providers", profileId) ?? [];
    for (const c of cfg) {
      try {
        ai.register(buildProvider(c, secrets().get(`${profileId}:${c.id}`)));
      } catch (e) {
        host.log.warn(`Skipping AI provider ${c.id}: ${(e as Error).message}`);
      }
    }
  }

  function buildProvider(c: ProviderConfig, apiKey?: string) {
    if (c.type === "ollama") return new OllamaProvider({ baseUrl: c.baseUrl, model: c.model, fetch: netFetch });
    if (c.type === "openai-compatible") return new OpenAICompatibleProvider({ id: c.id, baseUrl: c.baseUrl ?? "", model: c.model ?? "", apiKey, fetch: netFetch, label: c.label });
    if (!apiKey) throw new Error("Anthropic needs an API key");
    return new AnthropicProvider({ apiKey, model: c.model });
  }

  async function libraryMap(s: ProfileServices): Promise<Map<string, Reference>> {
    return new Map((await s.library.list()).map((i) => [i.ref.id, i.ref]));
  }

  async function addToLibrary(s: ProfileServices, ref: Reference, extra: Partial<LibraryItem> = {}): Promise<LibraryItem> {
    const all = await s.library.list();
    const taken = new Set(all.map((i) => i.ref.id));
    // Same DOI already present → update instead of duplicating.
    const dup = ref.DOI ? all.find((i) => i.ref.DOI?.toLowerCase() === ref.DOI!.toLowerCase()) : undefined;
    const now = new Date().toISOString();
    if (dup) {
      const merged: LibraryItem = { ...dup, ref: { ...dup.ref, ...ref, id: dup.ref.id }, updatedAt: now };
      await s.library.put(merged);
      return merged;
    }
    const id = ref.id && !taken.has(ref.id) ? ref.id : generateKey(ref, taken);
    const item: LibraryItem = { id, createdAt: now, updatedAt: now, tags: [], provenance: [], ...extra, ref: { ...ref, id } };
    await s.library.put(item);
    return item;
  }

  type Handler = (p: Record<string, unknown>, s: ProfileServices, ctx: { windowId: number; profileId: string; isPrivate: boolean }) => unknown;

  const handlers: Record<string, Handler> = {
    // ---- settings
    "settings.get": (_p, _s, ctx) => settings(ctx.profileId),
    "settings.set": (p, _s, ctx) => {
      const next: ResearchSettings = {
        ...settings(ctx.profileId),
        ...(typeof p.onlineLookups === "boolean" ? { onlineLookups: p.onlineLookups } : {}),
        ...(p.crossrefMailto !== undefined ? { crossrefMailto: optStr(p, "crossrefMailto", 200) } : {}),
        ...(p.defaultStyle !== undefined ? { defaultStyle: oneOf(p, "defaultStyle", ["apa", "ieee", "mla", "chicago"] as const) } : {}),
      };
      host.storage.kv.set("settings", next, ctx.profileId);
      return next;
    },

    // ---- notes
    "notes.list": (p, s) => s.notes.list({ workspaceId: p.workspaceId === null ? null : optStr(p, "workspaceId", 200), tag: optStr(p, "tag", 200) }),
    "notes.search": (p, s) => s.notes.search(str(p, "query", 500), { workspaceId: optStr(p, "workspaceId", 200) }),
    "notes.get": (p, s) => s.notes.get(str(p, "id", 100)),
    "notes.create": (p, s, ctx) => s.notes.create({ body: str(p, "body"), title: optStr(p, "title", 500), workspaceId: optStr(p, "workspaceId", 200), profileId: ctx.profileId }),
    "notes.update": (p, s) => {
      const patch = obj(p.patch, "patch");
      return s.notes.update(str(p, "id", 100), {
        ...(patch.body !== undefined ? { body: str(patch, "body") } : {}),
        ...(patch.title !== undefined ? { title: str(patch, "title", 500) } : {}),
        ...(typeof patch.pinned === "boolean" ? { pinned: patch.pinned } : {}),
        ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
        ...(patch.workspaceId !== undefined ? { workspaceId: optStr(patch, "workspaceId", 200) } : {}),
      });
    },
    "notes.delete": (p, s) => s.notes.delete(str(p, "id", 100)),
    "notes.capture": (p, s) => {
      const src = p.source ? obj(p.source, "source") : undefined;
      return s.notes.capture(str(p, "text", 20_000), { workspaceId: optStr(p, "workspaceId", 200), source: src ? { url: str(src, "url", 4000), title: optStr(src, "title", 500) } : undefined });
    },
    "notes.backlinks": (p, s) => s.notes.backlinks(str(p, "id", 100)),
    "notes.tags": (p, s) => s.notes.tagCounts(optStr(p, "workspaceId", 200)),

    // ---- library
    "library.list": async (p, s) => {
      const ws = optStr(p, "workspaceId", 200);
      return (await s.library.list((i) => !ws || i.workspaceId === ws || !i.workspaceId)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    "library.add": (p, s) => addToLibrary(s, obj(p.ref, "ref") as unknown as Reference, { workspaceId: optStr(p, "workspaceId", 200), provenance: ["manual"] }),
    "library.update": async (p, s) => {
      const id = str(p, "id", 200);
      const cur = await s.library.get(id);
      if (!cur) throw new PayloadError("Reference not found");
      const next: LibraryItem = { ...cur, ref: { ...(obj(p.ref, "ref") as unknown as Reference), id }, tags: p.tags ? strArray(p, "tags") : cur.tags, updatedAt: new Date().toISOString() };
      await s.library.put(next);
      return next;
    },
    "library.delete": (p, s) => s.library.delete(str(p, "id", 200)),
    "library.import": async (p, s) => {
      const format = oneOf(p, "format", ["bibtex", "ris", "csl-json"] as const);
      const text = str(p, "text", 20_000_000);
      let refs: Reference[];
      let errors: Array<{ offset?: number; message: string }> = [];
      if (format === "bibtex") ({ references: refs, errors } = importBibtex(text));
      else if (format === "ris") refs = importRis(text);
      else {
        const parsed = JSON.parse(text) as unknown;
        refs = (Array.isArray(parsed) ? parsed : [parsed]) as Reference[];
      }
      const added: string[] = [];
      for (const r of refs) added.push((await addToLibrary(s, r, { provenance: [format], workspaceId: optStr(p, "workspaceId", 200) })).id);
      return { added, errors };
    },
    "library.export": async (p, s) => {
      const ids = strArray(p, "ids", 100_000);
      const items = (await s.library.list()).filter((i) => !ids.length || ids.includes(i.id)).map((i) => i.ref);
      const format = oneOf(p, "format", ["bibtex", "ris", "csl-json"] as const);
      return format === "bibtex" ? exportBibtex(items) : format === "ris" ? exportRis(items) : JSON.stringify(items, null, 2);
    },
    "library.format": async (p, s) => {
      const style = oneOf(p, "style", ["apa", "ieee", "mla", "chicago"] as const);
      const ids = strArray(p, "ids", 100_000);
      const lib = await libraryMap(s);
      const bib = new Bibliography(style, [...lib.values()].filter((r) => !ids.length || ids.includes(r.id)));
      if (ids.length) bib.cite(ids);
      return bib.entries(true).map((e) => ({ id: e.id, label: e.label, text: e.text, html: e.html, inText: new Bibliography(style, [lib.get(e.id)!]).cite(e.id) }));
    },
    "library.check": async (_p, s) => {
      const refs = (await s.library.list()).map((i) => i.ref);
      return { issues: Object.fromEntries(refs.map((r) => [r.id, validateReference(r)])), duplicates: findDuplicates(refs) };
    },
    "library.lookup": async (p, s, ctx) => {
      const st = settings(ctx.profileId);
      if (!st.onlineLookups) throw new PayloadError("Online lookups are off. Turn on “Look up DOIs and arXiv IDs online” in Library settings.");
      const r = await lookupIdentifier(str(p, "identifier", 2000), { fetch: netFetch, mailto: st.crossrefMailto });
      return addToLibrary(s, r.reference, { provenance: [r.provenance], workspaceId: optStr(p, "workspaceId", 200) });
    },
    /** "Cite this page": capture the active tab's metadata into the library. */
    "library.captureTab": async (p, s, ctx) => {
      const tab = host.tabs.getActive(ctx.windowId);
      if (!tab) throw new PayloadError("No active tab.");
      const page = await host.tabs.getPageContent(tab.tabId);
      if (!page) throw new PayloadError("This page can't be read (internal or blocked page).");
      const st = settings(ctx.profileId);
      const result = await captureSource({ url: page.url, title: page.title, text: page.text, meta: { ...page.meta, ...(page.dois[0] && !page.meta["citation_doi"] ? { citation_doi: page.dois } : {}) } }, { online: st.onlineLookups, fetch: netFetch, mailto: st.crossrefMailto });
      if (p.preview === true) return result;
      const item = await addToLibrary(s, result.reference, { provenance: result.provenance, pdfUrl: result.pdfUrl, workspaceId: tab.workspaceId ?? undefined });
      return { item, warnings: result.warnings, contacted: result.contacted };
    },

    // ---- annotations
    "annotations.forSource": (p, s) => s.annotations.forSource(str(p, "source", 4000)),
    "annotations.highlight": (p, s) =>
      s.annotations.highlight({
        source: str(p, "source", 4000),
        sourceTitle: optStr(p, "sourceTitle", 500),
        text: str(p, "text", 5_000_000),
        start: int(p, "start", { min: 0 }),
        end: int(p, "end", { min: 1 }),
        page: int(p, "page", { optional: true, min: 1 }),
        color: p.color ? oneOf(p, "color", ["yellow", "green", "blue", "pink", "orange"] as const) : undefined,
        comment: optStr(p, "comment", 20_000),
        referenceId: optStr(p, "referenceId", 200),
        workspaceId: optStr(p, "workspaceId", 200),
      }),
    "annotations.update": (p, s) => s.annotations.update(str(p, "id", 100), { color: p.color as HighlightColor | undefined, comment: optStr(p, "comment", 20_000), tags: p.tags ? strArray(p, "tags") : undefined }),
    "annotations.delete": (p, s) => s.annotations.delete(str(p, "id", 100)),
    "annotations.markdown": async (p, s) => annotationsToMarkdown(await s.annotations.forSource(str(p, "source", 4000)), { heading: optStr(p, "heading", 500) }),
    "annotations.anchor": (p, s) => s.annotations.anchorAll(str(p, "source", 4000), str(p, "text", 5_000_000), int(p, "page", { optional: true, min: 1 })),

    // ---- papers
    "papers.list": (p, s) => s.papers.list(optStr(p, "workspaceId", 200)),
    "papers.create": (p, s) => s.papers.create({ templateId: str(p, "templateId", 100), title: optStr(p, "title", 500), workspaceId: optStr(p, "workspaceId", 200) }),
    "papers.get": (p, s) => s.papers.get(str(p, "id", 100)),
    "papers.delete": (p, s) => s.papers.delete(str(p, "id", 100)),
    "papers.update": (p, s) => s.papers.update(str(p, "id", 100), obj(p.patch, "patch") as never),
    "papers.updateSection": (p, s) => s.papers.updateSection(str(p, "id", 100), str(p, "sectionId", 100), obj(p.patch, "patch") as never),
    "papers.addSection": (p, s) => s.papers.addSection(str(p, "id", 100), str(p, "heading", 500), { after: optStr(p, "after", 100), level: p.level as 1 | 2 | 3 | undefined }),
    "papers.removeSection": (p, s) => s.papers.removeSection(str(p, "id", 100), str(p, "sectionId", 100)),
    "papers.moveSection": (p, s) => s.papers.moveSection(str(p, "id", 100), str(p, "sectionId", 100), p.delta === -1 ? -1 : 1),
    "papers.addReferences": (p, s) => s.papers.addReferences(str(p, "id", 100), strArray(p, "refIds")),
    "papers.snapshot": (p, s) => s.papers.snapshot(str(p, "id", 100), optStr(p, "label", 200)),
    "papers.restore": (p, s) => s.papers.restore(str(p, "id", 100), str(p, "at", 100)),
    "papers.recordAi": (p, s) => s.papers.recordAi(str(p, "id", 100), obj(p.contribution, "contribution") as never, optStr(p, "body")),
    "papers.check": async (p, s) => {
      const paper = await s.papers.get(str(p, "id", 100));
      return paper ? checkPaper(paper, await libraryMap(s)) : [];
    },
    "papers.export": async (p, s) => {
      const paper = await s.papers.get(str(p, "id", 100));
      if (!paper) throw new PayloadError("Paper not found");
      const lib = await libraryMap(s);
      const format = oneOf(p, "format", ["latex", "markdown", "pandoc", "html"] as const);
      if (format === "latex") return exportLatex(paper, lib);
      if (format === "markdown") return exportMarkdown(paper, lib);
      if (format === "pandoc") return { md: exportPandoc(paper), bib: exportBibtex([...lib.values()].filter((r) => paper.referenceIds.includes(r.id))) };
      return exportHtml(paper, lib);
    },
    "library.forPaper": async (p, s) => [...(await libraryMap(s)).values()],

    // ---- AI (optional; off until the user enables it)
    "ai.state": (_p, s, ctx) => ({
      settings: s.ai.settings,
      providers: s.ai.listProviders(),
      grants: s.ai.snapshot().grants,
      audit: s.ai.auditLog().slice(0, 200),
      configs: host.storage.kv.get<ProviderConfig[]>("ai-providers", ctx.profileId) ?? [],
      keysPersisted: !!(host as unknown as { secrets?: unknown }).secrets,
    }),
    "ai.updateSettings": (p, s) => {
      s.ai.updateSettings({
        ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : {}),
        ...(typeof p.confirmLocal === "boolean" ? { confirmLocal: p.confirmLocal } : {}),
        ...(typeof p.redactCloud === "boolean" ? { redactCloud: p.redactCloud } : {}),
        ...(p.activeProvider !== undefined ? { activeProvider: str(p, "activeProvider", 100) } : {}),
      });
      return s.ai.settings;
    },
    "ai.configureProvider": (p, s, ctx) => {
      const cfg: ProviderConfig = {
        id: str(p, "id", 100),
        type: oneOf(p, "type", ["ollama", "openai-compatible", "anthropic"] as const),
        baseUrl: optStr(p, "baseUrl", 500),
        model: optStr(p, "model", 200),
        label: optStr(p, "label", 100),
      };
      if (cfg.baseUrl && !/^https?:\/\//.test(cfg.baseUrl)) throw new PayloadError("baseUrl must start with http:// or https://");
      const key = optStr(p, "apiKey", 500);
      if (key) secrets().set(`${ctx.profileId}:${cfg.id}`, key);
      const provider = buildProvider(cfg, key ?? secrets().get(`${ctx.profileId}:${cfg.id}`));
      s.ai.unregister(cfg.id);
      s.ai.register(provider);
      if (!ctx.isPrivate) {
        const list = (host.storage.kv.get<ProviderConfig[]>("ai-providers", ctx.profileId) ?? []).filter((c) => c.id !== cfg.id);
        host.storage.kv.set("ai-providers", [...list, cfg], ctx.profileId);
      }
      return provider.info;
    },
    "ai.removeProvider": (p, s, ctx) => {
      const id = str(p, "id", 100);
      s.ai.unregister(id);
      s.ai.revoke(id);
      secrets().delete(`${ctx.profileId}:${id}`);
      host.storage.kv.set("ai-providers", (host.storage.kv.get<ProviderConfig[]>("ai-providers", ctx.profileId) ?? []).filter((c) => c.id !== id), ctx.profileId);
      return true;
    },
    "ai.grant": (p, s) => {
      s.ai.grant(str(p, "providerId", 100), strArray(p, "scopes", 10) as DataScope[], { ttlMs: int(p, "ttlMs", { optional: true, min: 1 }) });
      return true;
    },
    "ai.revoke": (p, s) => {
      s.ai.revoke(str(p, "providerId", 100), p.scopes ? (strArray(p, "scopes", 10) as DataScope[]) : undefined);
      return true;
    },
    "ai.clearAudit": (_p, s) => {
      s.ai.clearAudit();
      return true;
    },
    "ai.models": async (p, s) => {
      const id = str(p, "providerId", 100);
      return (await s.ai.getProvider(id)?.listModels?.()) ?? [];
    },
    /** Run a built-in task. Returns {ok:false, kind:"consent-required", detail} instead of throwing so the UI can ask. */
    "ai.run": async (p, s) => {
      const task = oneOf(p, "task", ["summarize", "explain", "revise", "outline", "claims"] as const);
      const text = str(p, "text", 400_000);
      const req =
        task === "summarize"
          ? summarizeTask(text, oneOf(p, "scope", ["selection", "page", "pdf", "note", "draft"] as const, "selection"), { length: p.length === "detailed" ? "detailed" : "brief" })
          : task === "explain"
            ? explainTask(text, optStr(p, "question", 4000))
            : task === "revise"
              ? reviseTask(text, oneOf(p, "goal", ["clarity", "concise", "formal", "grammar"] as const, "clarity"))
              : task === "outline"
                ? outlineTask(text, strArray(p, "references"))
                : claimCheckTask(text);
      try {
        return { ok: true, result: await s.ai.run(req) };
      } catch (e) {
        if (e instanceof AiError) return { ok: false, kind: e.kind, message: e.message, detail: e.kind === "consent-required" ? e.detail : undefined };
        throw e;
      }
    },
  };

  return {
    id: MODULE_ID,
    services,
    activate(h) {
      host = h;
      db = h.storage.db;
      h.storage.migrate(RESEARCH_MIGRATIONS);
      for (const [method, fn] of Object.entries(handlers)) {
        h.ipc.handle(method, async (payload, ctx) => {
          const p = payload === undefined ? {} : obj(payload);
          try {
            return await fn(p, services(ctx.profileId, ctx.isPrivate), ctx);
          } catch (e) {
            if (!(e instanceof PayloadError)) h.log.error(`${method} failed`, e);
            throw e;
          }
        });
      }
      h.events.on("profileDeleted", ({ profileId }) => {
        const n = deleteProfileData(db, profileId);
        persistent.delete(profileId);
        ephemeral.delete(profileId);
        h.storage.kv.delete("settings", profileId);
        h.storage.kv.delete("ai", profileId);
        for (const c of h.storage.kv.get<ProviderConfig[]>("ai-providers", profileId) ?? []) secrets().delete(`${profileId}:${c.id}`);
        h.storage.kv.delete("ai-providers", profileId);
        h.log.info(`Deleted ${n} research records for profile ${profileId}`);
      });
    },
    deactivate() {
      persistent.clear();
      ephemeral.clear();
    },
  };
}

export interface ProviderConfig {
  id: string;
  type: "ollama" | "openai-compatible" | "anthropic";
  baseUrl?: string;
  model?: string;
  label?: string;
}

export const researchMainModule = createResearchModule();
