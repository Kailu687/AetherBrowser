import { describe, expect, it } from "vitest";
import type { Reference } from "@aether/citations";
import { createMainModule } from "../src/index.js";
import { discover, googleScholarUrl, pubmedToHit } from "../src/discovery.js";
import { citationGraph, topicTimeline } from "../src/graph.js";
import { checkCitations, parseSupport } from "../src/support.js";
import { refineQuestion } from "../src/review.js";
import { ABSTRACT, fakeHost, testNet } from "./helpers.js";

const W = (id: string, doi: string, title: string, refs: string[] = []) => ({ id: `https://openalex.org/${id}`, doi: `https://doi.org/${doi}`, title, publication_year: 2020, authorships: [{ author: { display_name: "Ann Rao" } }], referenced_works: refs.map((r) => `https://openalex.org/${r}`), cited_by_count: 10 });

describe("PubMed and Google Scholar", () => {
  it("maps E-utilities summaries and never scrapes Scholar", async () => {
    const { net, calls } = testNet([
      (u) => (u.pathname.endsWith("esearch.fcgi") ? { body: { esearchresult: { idlist: ["123", "bad id"], count: "1" } } } : undefined),
      (u) => (u.pathname.endsWith("esummary.fcgi") ? { body: { result: { "123": { uid: "123", title: "ECG denoising.", authors: [{ name: "Rao AK", authtype: "Author" }], pubdate: "2021 Mar", fulljournalname: "Sensors", articleids: [{ idtype: "doi", value: "10.3390/s1" }, { idtype: "pmc", value: "PMC99" }] } } } } : undefined),
    ]);
    const run = await discover(net, { text: "ecg denoising" }, ["pubmed"]);
    expect(run.hits[0]!.reference).toMatchObject({ title: "ECG denoising", PMID: "123", DOI: "10.3390/s1", author: [{ family: "Rao", given: "A. K." }] });
    expect(run.hits[0]!.openAccessUrl).toBe("https://www.ncbi.nlm.nih.gov/pmc/articles/PMC99/");
    expect(new URL(calls[1]!.url).searchParams.get("id")).toBe("123");
    expect(pubmedToHit({ uid: "1; DROP", title: "x" })).toBeUndefined();
    expect(googleScholarUrl("a b")).toBe("https://scholar.google.com/scholar?q=a%20b");
  });
});

describe("citation graph", () => {
  it("links sources and explains every suggestion", async () => {
    const works: Record<string, unknown> = { "10.1000/a": W("W1", "10.1000/a", "A", ["W9", "W2"]), "10.1000/b": W("W2", "10.1000/b", "B", ["W9"]) };
    const { net } = testNet([
      (u) => {
        const m = u.pathname.match(/^\/works\/doi:(.+)$/);
        return m ? (works[decodeURIComponent(m[1]!)] ? { body: works[decodeURIComponent(m[1]!)] } : { status: 404, body: "" }) : undefined;
      },
      (u) => (u.pathname === "/works" && u.searchParams.get("filter")?.startsWith("cites:") ? { body: { results: [] } } : undefined),
      (u) => (u.pathname === "/works" && u.searchParams.get("filter")?.startsWith("openalex:") ? { body: { results: [W("W9", "10.1000/z", "Classic paper")] } } : undefined),
    ]);
    const refs: Reference[] = [{ id: "a", type: "article", title: "A", DOI: "10.1000/a" }, { id: "b", type: "article", title: "B", DOI: "10.1000/b" }, { id: "c", type: "article", title: "C" }];
    const g = await citationGraph(net, refs);
    expect(g.unresolved).toEqual(["c"]);
    expect(g.edges).toContainEqual({ from: "W1", to: "W2" });
    expect(g.suggestions[0]!.hit.reference.title).toBe("Classic paper");
    expect(g.suggestions[0]!.reasons[0]).toMatch(/Cited by 2 of your sources/);
  });
  it("builds a topic timeline from group_by", async () => {
    const { net } = testNet([() => ({ body: { group_by: [{ key: "2021", count: 5 }, { key: "2019", count: 2 }, { key: "junk", count: 1 }] } })]);
    expect((await topicTimeline(net, "x")).years).toEqual([{ year: 2019, count: 2 }, { year: 2021, count: 5 }]);
  });
});

describe("citation support check", () => {
  const refs = new Map<string, Reference>([["kumar2022", { id: "kumar2022", type: "article", title: "T", abstract: ABSTRACT }], ["empty", { id: "empty", type: "article", title: "E" }]]);
  const material = (k: string) => ({ abstract: refs.get(k)?.abstract, extractions: [], evidence: [] });
  it("grades citations and finds unknown, never-cited and uncited claims", () => {
    const md = [
      "The amplifier achieves an input-referred noise of 1.2 µVrms while consuming 2.1 µW [@kumar2022].",
      "It reduces power by 75% [@kumar2022].",
      "Quantum blockchain improves agriculture yields [@kumar2022].",
      "Deep learning is widely used in hospitals [@ghost].",
      "Other front ends are 30% less efficient than ours.",
      "See also [@empty].",
    ].join(" ");
    const r = checkCitations(md, refs, material, { attachedIds: ["kumar2022", "unused2020"] });
    const v = r.checks.map((c) => c.verdict);
    expect(v).toEqual(["overlap", "numbers-missing", "weak", "unknown-key", "no-material"]);
    expect(r.unknownKeys).toEqual(["ghost"]);
    expect(r.neverCited).toEqual(["unused2020"]);
    expect(r.uncitedClaims[0]).toMatch(/30% less efficient/);
    expect(r.limits.length).toBeGreaterThan(0);
  });
  it("discards an AI 'supports' verdict without a real quote", () => {
    expect(parseSupport('{"verdict":"supports","quote":"made up text here","reason":"r"}', ABSTRACT)!.verdict).toBe("cannot-tell");
    expect(parseSupport('{"verdict":"supports","quote":"consuming 2.1 µW","reason":"r"}', ABSTRACT)!.verdict).toBe("supports");
  });
});

describe("module extras", () => {
  it("scope criteria, reading queue, report and writer check through IPC", async () => {
    const h = fakeHost();
    const mod = createMainModule();
    await mod.activate(h.host);
    const p = await h.call("projects.create", { title: "ECG" });
    await h.call("projects.addSources", { id: p.id, refs: [{ id: "kumar2022", type: "article-journal", title: "Chopper amp", abstract: ABSTRACT, issued: { "date-parts": [[2022]] } }, { id: "old1999", type: "article-journal", title: "Old" }] });
    await h.call("projects.setScope", { id: p.id, statement: "Low-power ECG AFEs", inclusion: ["Reports measured noise"], exclusion: ["Simulation only"] });
    await expect(h.call("projects.screen", { id: p.id, sourceId: "old1999", status: "exclude", criteria: ["Made up"] })).rejects.toThrow(/Unknown screening criterion/);
    await h.call("projects.screen", { id: p.id, sourceId: "old1999", status: "exclude", criteria: ["Simulation only"] });
    await h.call("projects.screen", { id: p.id, sourceId: "kumar2022", status: "include", criteria: ["Reports measured noise"] });
    const rep = await h.call("projects.report", { id: p.id });
    expect(rep.markdown).toContain("Simulation only: 1");
    expect(rep.markdown).toContain("Included: 1");
    expect(rep.references.map((r: Reference) => r.id)).toEqual(["kumar2022"]);

    await h.call("reading.set", { refId: "kumar2022", status: "reading", relevance: 3, tags: { methodology: ["chopper"], dataset: ["MIT-BIH"] } });
    await h.call("reading.set", { refId: "lee2019" });
    expect((await h.call("reading.list", { status: "queued" })).map((r: { refId: string }) => r.refId)).toEqual(["lee2019"]);
    expect(await h.call("reading.facets")).toEqual({ methodology: { chopper: 1 }, dataset: { "MIT-BIH": 1 } });
    await expect(h.call("reading.set", { refId: "x", relevance: 9 })).rejects.toThrow();

    const q = await h.call("questions.create", { projectId: p.id, text: "noise" });
    const ref = await h.call("questions.refine", { id: q.id });
    expect(ref.checklist.find((c: { check: string }) => c.check === "Specific enough").ok).toBe(false);

    const chk = await h.call("writing.checkCitations", { markdown: "Noise is 1.2 µVrms at 2.1 µW [@kumar2022].", refs: [{ id: "kumar2022", type: "article", title: "x", abstract: ABSTRACT }] });
    expect(chk.checks[0].verdict).toBe("overlap");
    expect(await h.call("projects.searchTerm", { id: p.id, term: "MIT-BIH" })).toEqual(["kumar2022"]);
  });
  it("refinement checklist recognises a well-formed question", () => {
    expect(refineQuestion("How does chopper stabilisation affect input-referred noise in wearable ECG front ends compared with auto-zeroing since 2015?").every((c) => c.ok)).toBe(true);
  });
});
