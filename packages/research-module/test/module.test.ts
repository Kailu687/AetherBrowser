import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import type { MainHost, ShellEvents, PageContent } from "@aether/plugin-api";
import { createResearchModule } from "@aether/research-module";

// Loaded via require: Vite 5 does not recognise the node:sqlite builtin.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

type Handler = (payload: unknown, ctx: { windowId: number; profileId: string; isPrivate: boolean }) => unknown;

function fakeHost(opts: { page?: PageContent } = {}) {
  const db = new DatabaseSync(":memory:");
  const kv = new Map<string, unknown>();
  const handlers = new Map<string, Handler>();
  const listeners: Partial<Record<keyof ShellEvents, Array<(p: unknown) => void>>> = {};
  const fetched: string[] = [];
  const host = {
    moduleId: "research",
    storage: {
      db,
      migrate(ms: Array<{ version: number; up: string }>) {
        for (const m of ms) db.exec(m.up);
      },
      kv: {
        get: (k: string, p?: string) => kv.get(`${p}:${k}`),
        set: (k: string, v: unknown, p?: string) => void kv.set(`${p}:${k}`, structuredClone(v)),
        delete: (k: string, p?: string) => void kv.delete(`${p}:${k}`),
      },
    },
    ipc: { handle: (m: string, h: Handler) => void handlers.set(m, h), emit: () => undefined },
    events: { on: (n: keyof ShellEvents, l: (p: unknown) => void) => ((listeners[n] ??= []).push(l), () => undefined) },
    tabs: {
      getActive: () => ({ tabId: 1, windowId: 1, url: opts.page?.url ?? "", title: "", profileId: "p1", workspaceId: "ws1", isPrivate: false }),
      getPageContent: async () => opts.page ?? null,
    },
    net: { fetch: async (url: string) => (fetched.push(url), new Response("", { status: 404 })) },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  } as unknown as MainHost;
  const call = (method: string, payload: unknown = {}, ctx = { windowId: 1, profileId: "p1", isPrivate: false }) => {
    const h = handlers.get(method);
    if (!h) throw new Error(`no handler ${method}`);
    return h(payload, ctx) as Promise<any>;
  };
  const emit = <K extends keyof ShellEvents>(n: K, p: ShellEvents[K]) => listeners[n]?.forEach((l) => l(p));
  return { host, db, call, emit, fetched };
}

const BIB = "@article{he2016deep, author={He, Kaiming}, title={Deep residual learning}, journal={CVPR}, year={2016}, doi={10.1109/CVPR.2016.90}}";

describe("research module", () => {
  let h: ReturnType<typeof fakeHost>;
  beforeEach(() => {
    h = fakeHost({
      page: {
        url: "https://ieeexplore.ieee.org/document/1",
        title: "IEEE Xplore",
        text: "",
        selection: "",
        dois: [],
        meta: { citation_title: ["A 10-bit SAR ADC"], citation_author: ["Kumar, Priya"], citation_publication_date: ["2022/03/15"], citation_journal_title: ["IEEE JSSC"], citation_doi: ["10.1109/JSSC.2022.1"] },
      },
    });
    createResearchModule().activate(h.host);
  });

  it("isolates notes per profile and survives across module restarts", async () => {
    await h.call("notes.create", { body: "# VLSI\n#sta", workspaceId: "ws1" });
    await h.call("notes.capture", { text: "aircraft idea", workspaceId: "ws2" });
    expect((await h.call("notes.list", { workspaceId: "ws1" })).map((n: any) => n.title)).toEqual(["VLSI"]);
    expect(await h.call("notes.list", {}, { windowId: 1, profileId: "p2", isPrivate: false })).toEqual([]);
    // A fresh module instance reads the same SQLite rows.
    const handlers = new Map<string, Handler>();
    createResearchModule().activate({ ...h.host, ipc: { handle: (m: string, fn: Handler) => void handlers.set(m, fn), emit: () => undefined } } as unknown as MainHost);
    expect(await handlers.get("notes.list")!({ workspaceId: "ws2" }, { windowId: 1, profileId: "p1", isPrivate: false })).toHaveLength(1);
  });

  it("keeps private-window data in memory only", async () => {
    const priv = { windowId: 2, profileId: "p1", isPrivate: true };
    await h.call("notes.create", { body: "secret" }, priv);
    expect(await h.call("notes.list", {}, priv)).toHaveLength(1);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM research_docs").get()).toEqual({ n: 0 });
  });

  it("imports BibTeX, de-duplicates by DOI, formats and exports", async () => {
    const r = await h.call("library.import", { format: "bibtex", text: BIB });
    expect(r.added).toEqual(["he2016deep"]);
    await h.call("library.add", { ref: { id: "x", type: "article-journal", title: "Deep residual learning (dup)", DOI: "10.1109/cvpr.2016.90" } });
    expect(await h.call("library.list")).toHaveLength(1);
    const [f] = await h.call("library.format", { style: "apa" });
    expect(f.inText).toBe("(He, 2016)");
    expect(await h.call("library.export", { format: "bibtex" })).toContain("@article{he2016deep,");
  });

  it("cites the active tab offline, and refuses online lookups until enabled", async () => {
    const r = await h.call("library.captureTab");
    expect(r.item.ref).toMatchObject({ title: "A 10-bit SAR ADC", DOI: "10.1109/JSSC.2022.1", type: "article-journal" });
    expect(r.contacted).toEqual([]);
    expect(h.fetched).toEqual([]);
    await expect(h.call("library.lookup", { identifier: "10.1109/5.771073" })).rejects.toThrow(/Online lookups are off/);
  });

  it("writes papers with checks and LaTeX export", async () => {
    await h.call("library.import", { format: "bibtex", text: BIB });
    const p = await h.call("papers.create", { templateId: "ieee-conference", title: "ADC", workspaceId: "ws1" });
    await h.call("papers.updateSection", { id: p.id, sectionId: p.sections[2].id, patch: { body: "ResNets [@he2016deep] and [@ghost]." } });
    const issues = await h.call("papers.check", { id: p.id });
    expect(issues.some((i: any) => i.code === "unresolved-citation")).toBe(true);
    const { tex } = await h.call("papers.export", { id: p.id, format: "latex" });
    expect(tex).toContain("\\cite{he2016deep}");
  });

  it("keeps AI off by default, and asks for consent before cloud use", async () => {
    expect((await h.call("ai.run", { task: "summarize", text: "x" })).kind).toBe("disabled");
    await h.call("ai.updateSettings", { enabled: true });
    await h.call("ai.configureProvider", { id: "cloud", type: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k" });
    const r = await h.call("ai.run", { task: "summarize", text: "x", scope: "page" });
    expect(r).toMatchObject({ ok: false, kind: "consent-required", detail: { host: "api.example.com", missingScopes: ["page"] } });
    expect(h.fetched).toEqual([]);
    const state = await h.call("ai.state");
    expect(state.configs).toEqual([{ id: "cloud", type: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "m" }]);
    expect(JSON.stringify(state)).not.toContain('"k"');
    await expect(h.call("ai.configureProvider", { id: "bad", type: "ollama", baseUrl: "file:///etc" })).rejects.toThrow(/http/);
  });

  it("validates payloads and deletes everything for a deleted profile", async () => {
    await expect(h.call("notes.create", { body: 42 })).rejects.toThrow(/body must be a string/);
    await expect(h.call("notes.create", "nope")).rejects.toThrow(/object/);
    await h.call("notes.create", { body: "a" });
    await h.call("library.import", { format: "bibtex", text: BIB });
    h.emit("profileDeleted", { profileId: "p1" });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM research_docs").get()).toEqual({ n: 0 });
    expect(await h.call("notes.list")).toEqual([]);
  });
});
