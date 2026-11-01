import { describe, expect, it } from "vitest";
import type { Reference } from "@aether/citations";
import { ARXIV_FEED, CROSSREF_WORK, OPENALEX_WORK, ABSTRACT, testNet } from "./helpers.js";
import { NetError } from "../src/net.js";
import { discover, invertedIndexToText, mergeHits, openAlexToHit, searchCrossref } from "../src/discovery.js";
import { verifyReference, applyCorrections } from "../src/verify.js";
import { qualityReport, citedKeys } from "../src/quality.js";
import { heuristicSuggestions, parseAiSuggestions } from "../src/extraction.js";
import { containsQuote, csvCell, safeUrl, sentences, titleSimilarity } from "../src/text.js";

const crossrefRoute = (url: URL) => (url.host === "api.crossref.org" && url.pathname === "/works" ? { body: { message: { items: [CROSSREF_WORK], "total-results": 1 } } } : undefined);
const openalexRoute = (url: URL) => (url.host === "api.openalex.org" && url.pathname === "/works" ? { body: { results: [OPENALEX_WORK], meta: { count: 1 } } } : undefined);
const arxivRoute = (url: URL) => (url.host === "export.arxiv.org" ? { body: ARXIV_FEED } : undefined);

describe("LabNet guard", () => {
  it("refuses everything when online features are off, and sends nothing", async () => {
    const { net, calls } = testNet([crossrefRoute], false);
    await expect(net.getText("https://api.crossref.org/works", { service: "crossref", purpose: "x", sent: "q" })).rejects.toMatchObject({ kind: "offline" });
    expect(calls).toHaveLength(0);
  });
  it("blocks non-https, credentials, ports and hosts outside the allowlist", async () => {
    const { net, calls, log } = testNet([() => ({ body: "{}" })]);
    for (const u of ["http://api.crossref.org/works", "https://evil.example.com/x", "https://user:pw@api.crossref.org/", "https://api.crossref.org:8443/", "https://api.crossref.org.evil.com/"]) {
      await expect(net.getText(u, { service: "t", purpose: "t", sent: "" })).rejects.toBeInstanceOf(NetError);
    }
    expect(calls).toHaveLength(0);
    expect(log.length).toBeGreaterThan(0);
  });
  it("logs metadata only and maps 404/429", async () => {
    const { net, log } = testNet([(u) => (u.pathname === "/works/x" ? { status: 429, body: "" } : undefined)]);
    await expect(net.getText("https://api.crossref.org/works/x", { service: "crossref", purpose: "p", sent: "x" })).rejects.toMatchObject({ kind: "rate-limited" });
    await expect(net.getText("https://api.crossref.org/works/y", { service: "crossref", purpose: "p", sent: "y" })).rejects.toMatchObject({ kind: "not-found" });
    expect(log[0]).toMatchObject({ host: "api.crossref.org", status: 429, sent: "x" });
    expect(JSON.stringify(log)).not.toContain("not found");
  });
  it("rejects oversized responses", async () => {
    const { net } = testNet([() => ({ body: "x".repeat(5_000_001) })]);
    await expect(net.getText("https://api.openalex.org/works", { service: "o", purpose: "p", sent: "" })).rejects.toMatchObject({ kind: "too-large" });
  });
});

describe("discovery", () => {
  it("maps Crossref results and sends only the query (and mailto when set)", async () => {
    const { net, calls } = testNet([crossrefRoute]);
    const r = await searchCrossref(net, { text: "residual learning", fromYear: 2015 }, { mailto: "me@uni.edu" });
    expect(r.hits[0]!.reference).toMatchObject({ title: "Deep Residual Learning for Image Recognition", DOI: "10.1109/CVPR.2016.90", type: "paper-conference" });
    expect(r.hits[0]!.citedBy).toBe(150000);
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("query.bibliographic")).toBe("residual learning");
    expect(u.searchParams.get("filter")).toBe("from-pub-date:2015");
    expect(u.searchParams.get("mailto")).toBe("me@uni.edu");
  });
  it("rebuilds OpenAlex abstracts and keeps only safe links", () => {
    expect(invertedIndexToText({ b: [1], a: [0], c: [2] })).toBe("a b c");
    const hit = openAlexToHit({ ...OPENALEX_WORK, best_oa_location: { pdf_url: "javascript:alert(1)" }, primary_location: { source: { display_name: "CVPR" }, landing_page_url: "javascript:alert(1)" } })!;
    expect(hit.openAccessUrl).toBeUndefined();
    expect(hit.reference.URL).toBeUndefined();
    expect(hit.reference.DOI).toBe("10.1109/cvpr.2016.90");
  });
  it("merges the same work from several services into one hit", async () => {
    const { net } = testNet([crossrefRoute, openalexRoute, arxivRoute]);
    const run = await discover(net, { text: "deep residual learning" }, ["crossref", "openalex", "arxiv"]);
    expect(run.hits).toHaveLength(1);
    const h = run.hits[0]!;
    expect(h.found.map((f) => f.service).sort()).toEqual(["arxiv", "crossref", "openalex"]);
    expect(h.reference.abstract).toBeTruthy(); // filled from OpenAlex, not invented
    expect(h.openAccessUrl).toBe("https://arxiv.org/pdf/1512.03385");
  });
  it("one failing service does not fail the search", async () => {
    const { net } = testNet([crossrefRoute, (u) => (u.host === "api.openalex.org" ? { status: 500, body: "" } : undefined)]);
    const run = await discover(net, { text: "residual" }, ["crossref", "openalex"]);
    expect(run.hits).toHaveLength(1);
    expect(run.services.find((s) => s.service === "openalex")!.error).toMatch(/500/);
  });
  it("does not merge different works with similar titles", () => {
    const a = { key: "doi:10.1/a", reference: { id: "a", type: "article", title: "Deep learning", DOI: "10.1/a" } as Reference, found: [{ service: "crossref" as const }] };
    const b = { key: "doi:10.1/b", reference: { id: "b", type: "article", title: "Deep learning for robots", DOI: "10.1/b" } as Reference, found: [{ service: "openalex" as const }] };
    expect(mergeHits([{ service: "crossref", hits: [a] }, { service: "openalex", hits: [b] }])).toHaveLength(2);
  });
});

const ours: Reference = { id: "he2016deep", type: "paper-conference", title: "Deep residual learning for image recognition", author: [{ family: "He", given: "Kaiming" }], issued: { "date-parts": [[2016]] }, DOI: "10.1109/CVPR.2016.90", "container-title": "2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)" };
const doiRoute = (work: unknown, extra: Record<string, unknown> = {}) => (u: URL) => (u.host === "api.crossref.org" && u.pathname.startsWith("/works/10.") ? { body: { message: { ...(work as object), ...extra } } } : undefined);

describe("verification", () => {
  it("verifies a matching DOI", async () => {
    const { net } = testNet([doiRoute(CROSSREF_WORK), (u) => (u.host === "api.openalex.org" ? { body: OPENALEX_WORK } : undefined)]);
    const v = await verifyReference(net, ours, { checkRetractions: true });
    expect(v.status).toBe("verified");
    expect(v.notices).toEqual([]);
  });
  it("flags a DOI that resolves to a different paper", async () => {
    const { net } = testNet([doiRoute({ ...CROSSREF_WORK, title: ["A survey of wireless sensor networks"], author: [{ family: "Akyildiz" }], issued: { "date-parts": [[2002]] } })]);
    const v = await verifyReference(net, ours);
    expect(v.status).toBe("mismatch");
    expect(v.diffs.map((d) => d.field).sort()).toEqual(["author", "issued", "title"]);
    expect(v.diffs.every((d) => d.severity === "error")).toBe(true);
  });
  it("reports a DOI that resolves nowhere as not-found (possible fabrication)", async () => {
    const { net } = testNet([]);
    const v = await verifyReference(net, { ...ours, DOI: "10.9999/made.up.2024" });
    expect(v.status).toBe("not-found");
    expect(v.message).toMatch(/does not resolve/);
  });
  it("reports retraction notices from Crossref and OpenAlex", async () => {
    const { net } = testNet([doiRoute(CROSSREF_WORK, { "updated-by": [{ type: "retraction", label: "Retraction", DOI: "10.1/notice", source: "retraction-watch" }] }), (u) => (u.host === "api.openalex.org" ? { body: { ...OPENALEX_WORK, is_retracted: true } } : undefined)]);
    const v = await verifyReference(net, ours, { checkRetractions: true });
    expect(v.notices).toHaveLength(1);
    expect(v.notices[0]).toMatchObject({ kind: "retraction", source: "Retraction Watch via Crossref" });
  });
  it("suggests a candidate DOI only on a confident title + author match", async () => {
    const noDoi = { ...ours, DOI: undefined };
    const { net } = testNet([crossrefRoute]);
    const v = await verifyReference(net, noDoi);
    expect(v.status).toBe("candidate");
    expect(v.candidate?.DOI).toBe("10.1109/CVPR.2016.90");
    const fixed = applyCorrections(noDoi, v.candidate!, ["DOI"]);
    expect(fixed.DOI).toBe("10.1109/CVPR.2016.90");
    expect(fixed.title).toBe(noDoi.title);

    const other = { ...noDoi, title: "Wavelet compression of ECG signals", author: [{ family: "Rao" }] };
    const v2 = await verifyReference(net, other);
    expect(v2.status).toBe("unmatched");
    expect(v2.message).toMatch(/does not mean the work does not exist/);
  });
  it("verifies arXiv ids and points to the published version", async () => {
    const { net } = testNet([arxivRoute]);
    const v = await verifyReference(net, { id: "he2015", type: "article", title: "Deep Residual Learning for Image Recognition", author: [{ family: "He" }], issued: { "date-parts": [[2015]] }, archive: "arXiv", archive_location: "1512.03385" });
    expect(v.status).toBe("verified");
    expect(v.message).toMatch(/published version has DOI 10.1109\/CVPR.2016.90/);
  });
  it("returns offline instead of throwing when online is off", async () => {
    const { net } = testNet([], false);
    expect((await verifyReference(net, ours)).status).toBe("offline");
  });
});

describe("quality report", () => {
  it("lists concrete findings with severities and its own limits", () => {
    const refs: Reference[] = [ours, { id: "x", type: "article-journal", title: "Untraceable claim" }, { ...ours, id: "dup" }];
    const ver = new Map([["he2016deep", { id: "he2016deep", refId: "he2016deep", status: "not-found", message: "DOI does not resolve", diffs: [], notices: [], checkedAt: "", createdAt: "", updatedAt: "" } as never]]);
    const r = qualityReport(refs, ver, { citedKeys: citedKeys("As shown [@he2016deep; @ghost2020, p. 3].") });
    const codes = r.findings.map((f) => `${f.refId}:${f.code}`);
    expect(codes).toContain("he2016deep:doi-not-found");
    expect(codes).toContain("x:no-identifier");
    expect(codes).toContain("dup:duplicate");
    expect(codes).toContain("ghost2020:cited-not-in-library");
    expect(r.findings[0]!.severity).toBe("error");
    expect(r.limits.length).toBeGreaterThan(0);
  });
});

describe("extraction", () => {
  it("suggests fields from cue phrases with verbatim quotes", () => {
    const s = heuristicSuggestions(ABSTRACT);
    const by = Object.fromEntries(s.map((x) => [x.field, x.text]));
    expect(by.objective).toMatch(/investigates/);
    expect(by.methods).toMatch(/We propose/);
    expect(by.datasets).toMatch(/MIT-BIH/);
    expect(by.findings).toMatch(/Results show/);
    expect(by.limitations).toMatch(/does not address/);
    expect(by.futureWork).toMatch(/Future work/);
    for (const x of s) expect(containsQuote(ABSTRACT, x.quote!)).toBe(true);
  });
  it("drops AI suggestions whose quote is not in the text", () => {
    const raw = `Here you go: [{"field":"findings","text":"Low noise","quote":"achieves an input-referred noise of 1.2 µVrms"},{"field":"findings","text":"Beats all prior work by 40%","quote":"outperforms all prior work by 40%"},{"field":"bogus","text":"x","quote":"y"}]`;
    const r = parseAiSuggestions(raw, ABSTRACT);
    expect(r.accepted.map((a) => a.text)).toEqual(["Low noise"]);
    expect(r.rejected).toHaveLength(2);
    expect(parseAiSuggestions("no json", ABSTRACT).accepted).toEqual([]);
  });
});

describe("text helpers", () => {
  it("keeps abbreviations inside sentences", () => {
    expect(sentences("He et al. proposed ResNet. It works, e.g. on ImageNet. Done.")).toHaveLength(3);
  });
  it("protects CSV against formula injection", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1")).toBe("'+1");
  });
  it("only passes http(s) URLs", () => {
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl("data:text/html,x")).toBeUndefined();
    expect(safeUrl("https://arxiv.org/abs/1")).toBe("https://arxiv.org/abs/1");
  });
  it("title similarity separates near-identical from different titles", () => {
    expect(titleSimilarity("Deep Residual Learning for Image Recognition", "Deep residual learning for image recognition.")).toBe(1);
    expect(titleSimilarity("Deep learning", "Deep residual learning for image recognition")).toBeLessThan(0.6);
  });
});
