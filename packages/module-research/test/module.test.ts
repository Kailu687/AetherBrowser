import { describe, expect, it, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Reference } from "@aether/citations";
import { createMainModule, manifest } from "../src/index.js";
import { ABSTRACT, CROSSREF_WORK, fakeHost } from "./helpers.js";

const REF: Reference = { id: "kumar2022", type: "article-journal", title: "A 2 µW chopper amplifier for wearable ECG", author: [{ family: "Kumar", given: "Priya" }], issued: { "date-parts": [[2022]] }, "container-title": "IEEE JSSC", DOI: "10.1109/JSSC.2022.1", abstract: ABSTRACT };
const REF2: Reference = { id: "lee2019", type: "article-journal", title: "Motion artefact removal in ECG", author: [{ family: "Lee" }], issued: { "date-parts": [[2019]] }, abstract: "We propose adaptive filtering for ECG motion artefacts using accelerometer data. Results show a 40% reduction in false alarms. A limitation is the small sample of 12 participants." };

async function setup(opts: Parameters<typeof fakeHost>[0] = {}) {
  const h = fakeHost(opts);
  const mod = createMainModule();
  await mod.activate(h.host);
  return { ...h, mod };
}

describe("Research & Writing module main module", () => {
  let h: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    h = await setup();
  });

  it("uses the manifest id and starts with online features off", async () => {
    expect(h.mod.id).toBe(manifest.id);
    const st = await h.call("settings.get");
    expect(st.online).toBe(false);
    expect(st.trail).toBe(false);
    await expect(h.call("discover.search", { text: "ecg amplifier" })).rejects.toThrow(/Online features are off/);
    expect(h.calls).toHaveLength(0);
  });

  it("runs a full offline review workflow with traceable output", async () => {
    const p = await h.call("projects.create", { title: "Wearable ECG front ends" });
    await h.call("projects.addSources", { id: p.id, refs: [REF, REF2] });
    const q = await h.call("questions.create", { projectId: p.id, text: "Can µW-level front ends reach clinical noise levels?" });

    // Evidence must come from a source in the project.
    await expect(h.call("evidence.create", { projectId: p.id, questionId: q.id, sourceId: "ghost2020", stance: "supports", claim: "x" })).rejects.toThrow(/Add the source/);
    await h.call("evidence.create", { projectId: p.id, questionId: q.id, sourceId: "kumar2022", stance: "supports", claim: "1.2 µVrms at 2.1 µW", locator: { page: 4 } });

    const sug = await h.call("extract.suggest", { projectId: p.id, sourceId: "kumar2022" });
    expect(sug.created.length).toBeGreaterThan(3);
    expect(sug.created.every((c: { status: string; quote: string }) => c.status === "suggested" && c.quote)).toBe(true);
    // Suggestions do not fill the matrix until accepted.
    let m = await h.call("matrix.get", { projectId: p.id });
    expect(m.rows[0].cells.every((c: { kind: string }) => c.kind === "empty")).toBe(true);
    const methods = sug.created.find((c: { field: string }) => c.field === "methods");
    await h.call("extract.update", { id: methods.id, status: "accepted", labels: ["chopper amplifier"] });
    m = await h.call("matrix.get", { projectId: p.id });
    const mcell = m.rows[0].cells[m.criteria.findIndex((c: { field: string }) => c.field === "methods")];
    expect(mcell).toMatchObject({ kind: "derived", itemIds: [methods.id] });

    const out = await h.call("outline.get", { projectId: p.id });
    expect(out.markdown).toContain("[@kumar2022, p. 4]");
    expect(out.markdown).toContain("Rewrite in your own words");
    for (const s of out.outline.sections) for (const b of s.bullets) expect(b.cites.length).toBeGreaterThan(0);
    expect(out.references.map((r: Reference) => r.id)).toContain("kumar2022");

    const gaps = await h.call("gaps.list", { projectId: p.id });
    expect(gaps.map((g: { kind: string }) => g.kind)).toContain("thin-evidence");
    expect(gaps.every((g: { caveat: string }) => g.caveat.length > 0)).toBe(true);
    await h.call("gaps.decide", { projectId: p.id, key: gaps[0].key, status: "kept" });
    expect((await h.call("gaps.list", { projectId: p.id }))[0].decision).toBe("kept");

    const csv = await h.call("matrix.export", { projectId: p.id, format: "csv" });
    expect(csv.split("\r\n")[0]).toMatch(/^Source,/);
  });

  it("exports and re-imports a project without overwriting the original", async () => {
    const p = await h.call("projects.create", { title: "Review" });
    await h.call("projects.addSources", { id: p.id, refs: [REF] });
    const q = await h.call("questions.create", { projectId: p.id, text: "Q1" });
    await h.call("evidence.create", { projectId: p.id, questionId: q.id, sourceId: "kumar2022", stance: "context", claim: "c" });
    const file = await h.call("projects.export", { id: p.id });
    const imported = await h.call("projects.import", { text: file });
    expect(imported.id).not.toBe(p.id);
    const ev = await h.call("evidence.list", { projectId: imported.id });
    const qs = await h.call("questions.list", { projectId: imported.id });
    expect(ev[0].questionId).toBe(qs[0].id);
    expect((await h.call("evidence.list", { projectId: p.id }))).toHaveLength(1);
    await expect(h.call("projects.import", { text: '{"format":"other"}' })).rejects.toThrow(/Not an AETHER/);
  });

  it("validates payloads strictly", async () => {
    await expect(h.call("projects.get", { id: "../../etc/passwd" })).rejects.toThrow(/valid id/);
    await expect(h.call("projects.create", { title: 42 })).rejects.toThrow(/string/);
    const p = await h.call("projects.create", { title: "x" });
    await expect(h.call("projects.addSources", { id: p.id, refs: [{ id: "a b c" }] })).rejects.toThrow(/valid id/);
    // Unknown fields are dropped from references.
    const r = await h.call("projects.addSources", { id: p.id, refs: [{ id: "ok1", type: "article", title: "T", __proto__x: 1, onload: "x" }] });
    expect(Object.keys(r.sources.ok1).sort()).toEqual(["id", "title", "type"]);
  });

  it("searches only enabled services once online, and keeps searches for offline review", async () => {
    const hh = await setup({ routes: [(u) => (u.host === "api.crossref.org" ? { body: { message: { items: [CROSSREF_WORK] } } } : undefined)] });
    await hh.call("settings.set", { online: true, services: { openalex: false, arxiv: false, pubmed: false } });
    const run = await hh.call("discover.search", { text: "residual" });
    expect(run.hits).toHaveLength(1);
    expect(new Set(hh.calls.map((c) => new URL(c.url).host))).toEqual(new Set(["api.crossref.org"]));
    const log = await hh.call("net.log");
    expect(log[0]).toMatchObject({ host: "api.crossref.org", sent: "residual" });
    expect(await hh.call("discover.history")).toHaveLength(1);
  });

  it("verifies references and stores the result for the offline quality report", async () => {
    const hh = await setup({ routes: [(u) => (u.pathname.startsWith("/works/10.") ? { status: 404, body: "" } : undefined)] });
    await hh.call("settings.set", { online: true });
    const [v] = await hh.call("verify.run", { refs: [REF] });
    expect(v.status).toBe("not-found");
    expect(hh.emitted.some((e) => e.event === "verify.progress")).toBe(true);
    await hh.call("settings.set", { online: false });
    const report = await hh.call("quality.report", { refs: [REF] });
    expect(report.findings.some((f: { code: string }) => f.code === "doi-not-found")).toBe(true);
  });

  it("only sends AI suggestions that quote the text, and works without AI", async () => {
    const hh = await setup({ ai: () => ({ text: '[{"field":"findings","text":"Invented","quote":"reduces power by 90% compared to all prior art"},{"field":"metrics","text":"Noise","quote":"input-referred noise of 1.2 µVrms"}]' }) });
    const p = await hh.call("projects.create", { title: "x" });
    await hh.call("projects.addSources", { id: p.id, refs: [REF] });
    const r = await hh.call("extract.suggest", { projectId: p.id, sourceId: "kumar2022", useAi: true });
    expect(r.ai).toMatchObject({ used: true, added: 1 });
    expect(r.ai.rejected).toHaveLength(1);
    expect(hh.aiCalls[0]!.scope).toBe("references");
    const noAi = await h.call("projects.create", { title: "y" });
    await h.call("projects.addSources", { id: noAi.id, refs: [REF] });
    const r2 = await h.call("extract.suggest", { projectId: noAi.id, sourceId: "kumar2022", useAi: true });
    expect(r2.ai.used).toBe(false);
  });

  it("keeps private-window data in memory only", async () => {
    const priv = { windowId: 2, profileId: "p1", isPrivate: true };
    await h.call("projects.create", { title: "secret review" }, priv);
    expect(await h.call("projects.list", {}, priv)).toHaveLength(1);
    expect(await h.call("projects.list")).toHaveLength(0);
    const rows = h.db.prepare("SELECT COUNT(*) AS n FROM module_research_docs").get() as { n: number };
    expect(rows.n).toBe(0);
    await expect(h.call("saved.add", {}, priv)).rejects.toThrow(/private/);
  });

  it("saves pages for offline reading with an archive and full-text search", async () => {
    const hh = await setup({ savePage: true, page: { url: "https://example.org/sar-adc", title: "SAR ADC design notes", text: "Successive approximation ADCs trade speed for power. Capacitor mismatch limits linearity.", meta: {}, dois: [], selection: "" } });
    const rec = await hh.call("saved.add");
    expect(rec.archive).toMatch(/\.mhtml$/);
    expect(existsSync(join(hh.dataDir, "pages", rec.archive))).toBe(true);
    const hits = await hh.call("saved.search", { query: "capacitor mismatch" });
    expect(hits[0]).toMatchObject({ id: rec.id });
    expect(hits[0].snippet).toMatch(/Capacitor mismatch/);
    const arch = await hh.call("saved.archive", { id: rec.id });
    expect(arch.content).toContain("multipart/related");
    await hh.call("saved.delete", { id: rec.id });
    expect(existsSync(join(hh.dataDir, "pages", rec.archive))).toBe(false);
  });

  it("records the trail only when enabled, never private, without query strings", async () => {
    const nav = (url: string, isPrivate = false) => h.emit("tabNavigated", { tabId: 1, windowId: 1, url, title: "T", profileId: "p1", workspaceId: "ws1", isPrivate, inPage: false });
    nav("https://example.org/a?token=secret");
    await new Promise((r) => setTimeout(r, 5));
    expect(await h.call("trail.list")).toHaveLength(0);
    await h.call("settings.set", { trail: true });
    nav("https://example.org/a?token=secret#x");
    nav("https://example.org/a?other=1");
    nav("https://private.example/", true);
    nav("file:///C:/Users/me/doc.pdf");
    await new Promise((r) => setTimeout(r, 5));
    const t = await h.call("trail.list");
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ url: "https://example.org/a", visits: 2 });
    expect(JSON.stringify(t)).not.toContain("secret");
  });

  it("deletes everything for a deleted profile, including API keys", async () => {
    await h.call("projects.create", { title: "x" });
    await h.call("settings.setKey", { service: "openalex", key: "abc" });
    expect((await h.call("settings.get")).keys.openalex).toBe(true);
    h.emit("profileDeleted", { profileId: "p1" });
    expect(await h.call("projects.list")).toHaveLength(0);
    expect(h.secrets.size).toBe(0);
  });
});

describe("manifest", () => {
  it("follows the Modules contract", () => {
    expect(manifest.id).toBe("aether.module.research");
    expect(manifest.layer).toBe("module");
    expect(manifest.limits.length).toBeGreaterThan(0);
    const vocab = new Set(["storage", "tabs.read", "files.pick", "files.folder", "process.run", "process.servers", "ai.optional", "secrets"]);
    for (const p of manifest.permissions) expect(vocab.has(p) || /^net:[a-z0-9.-]+$/.test(p)).toBe(true);
    expect(manifest.permissions.some((p) => p.startsWith("process"))).toBe(false);
    for (const a of manifest.apps) expect(a.id.startsWith("research.")).toBe(true);
  });
});

describe("hardening", () => {
  it("rejects prototype-polluting keys from IPC and imported files", async () => {
    const h = fakeHost();
    const mod = createMainModule();
    await mod.activate(h.host);
    const p = await h.call("projects.create", { title: "x" });
    await expect(h.call("projects.setCell", { id: p.id, sourceId: "__proto__", criterionId: "methods", text: "x" })).rejects.toThrow(/valid id/);
    const file = JSON.stringify({ format: "aether-research-project", project: { title: "t", sourceIds: [], cells: { __proto__: { polluted: { text: "x" } } }, screening: {} } });
    const evil = file.replace('"cells":{}', '"cells":{"__proto__":{"polluted":{"text":"x"}}}');
    await expect(h.call("projects.import", { text: evil })).rejects.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
