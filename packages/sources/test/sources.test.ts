import { describe, it, expect } from "vitest";
import { parseArxivId, parseArxivAtom, extractDoi, crossrefToReference, lookupDoi, parseMetaTags, referenceFromMeta, captureSource, normalizeIsbn, LookupError, type FetchLike } from "@aether/sources";
import { formatReference, toPlain } from "@aether/citations";

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need</title>
    <summary>The dominant sequence transduction models &amp; more.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

const CROSSREF = {
  status: "ok",
  message: {
    DOI: "10.1109/5.771073",
    type: "journal-article",
    title: ["Toward unique identifiers"],
    author: [{ given: "N.", family: "Paskin" }],
    "container-title": ["Proceedings of the IEEE"],
    issued: { "date-parts": [[1999, 7]] },
    volume: "87",
    issue: "7",
    page: "1208-1227",
    publisher: "Institute of Electrical and Electronics Engineers (IEEE)",
    abstract: "<jats:p>Identifiers <jats:italic>matter</jats:italic>.</jats:p>",
  },
};

function mockFetch(routes: Record<string, { status?: number; body: unknown }>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.startsWith(k));
    if (!hit) return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    const { status = 200, body } = hit[1];
    return { ok: status < 400, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => body };
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

describe("identifiers", () => {
  it("parses arXiv ids in many forms", () => {
    expect(parseArxivId("https://arxiv.org/abs/2101.00001v3")).toEqual({ id: "2101.00001", version: "v3" });
    expect(parseArxivId("https://arxiv.org/pdf/1706.03762.pdf")).toEqual({ id: "1706.03762" });
    expect(parseArxivId("arXiv:hep-th/9901001")).toEqual({ id: "hep-th/9901001" });
    expect(parseArxivId("math.GT/0309136")).toEqual({ id: "math.GT/0309136" });
    expect(parseArxivId("not an id")).toBeUndefined();
  });
  it("extracts DOIs from urls and text", () => {
    expect(extractDoi("https://doi.org/10.1109/5.771073")).toBe("10.1109/5.771073");
    expect(extractDoi("see (doi: 10.1016/j.cell.2020.01.001).")).toBe("10.1016/j.cell.2020.01.001");
    expect(extractDoi("https://ieeexplore.ieee.org/document/123")).toBeUndefined();
    expect(extractDoi("https://link.springer.com/content/pdf/10.1007/s11263-015-0816-y.pdf")).toBe("10.1007/s11263-015-0816-y");
  });
  it("validates ISBNs", () => {
    expect(normalizeIsbn("0-306-40615-2")).toBe("9780306406157");
    expect(normalizeIsbn("978-0-306-40615-7")).toBe("9780306406157");
    expect(normalizeIsbn("978-0-306-40615-8")).toBeUndefined();
  });
});

describe("arXiv", () => {
  it("parses the Atom feed", () => {
    const [r] = parseArxivAtom(ATOM);
    expect(r).toMatchObject({
      id: "vaswani2017attention",
      title: "Attention Is All You Need",
      archive_location: "1706.03762",
      version: "7",
      issued: { "date-parts": [[2017, 6, 12]] },
      abstract: "The dominant sequence transduction models & more.",
      keyword: "cs.CL",
    });
    expect(r!.author).toEqual([{ family: "Vaswani", given: "Ashish" }, { family: "Shazeer", given: "Noam" }]);
    expect(toPlain(formatReference(r!, "ieee"))).toContain("arXiv:1706.03762");
  });
});

describe("Crossref", () => {
  it("maps works to references", () => {
    const r = crossrefToReference(CROSSREF.message);
    expect(r).toMatchObject({ id: "paskin1999unique", type: "article-journal", page: "1208–1227", "container-title": "Proceedings of the IEEE", abstract: "Identifiers matter ." });
  });
  it("looks up via injected fetch and sends mailto only when configured", async () => {
    const f = mockFetch({ "https://api.crossref.org/works/": { body: CROSSREF } });
    const r = await lookupDoi("https://doi.org/10.1109/5.771073", { fetch: f });
    expect(r.DOI).toBe("10.1109/5.771073");
    expect(f.calls[0]).toBe("https://api.crossref.org/works/10.1109%2F5.771073");
    await lookupDoi("10.1109/5.771073", { fetch: f, mailto: "me@example.org" });
    expect(f.calls[1]).toContain("mailto=me%40example.org");
  });
  it("falls back to doi.org content negotiation", async () => {
    const f = mockFetch({ "https://doi.org/": { body: { type: "dataset", title: "Zenodo data", author: [{ family: "Roe" }], issued: { "date-parts": [[2021]] } } } });
    const r = await lookupDoi("10.5281/zenodo.1234", { fetch: f });
    expect(r).toMatchObject({ id: "roe2021zenodo", type: "dataset", DOI: "10.5281/zenodo.1234" });
  });
  it("reports typed errors", async () => {
    await expect(lookupDoi("nope")).rejects.toMatchObject({ kind: "invalid-input" });
    const f = mockFetch({ "https://api.crossref.org/": { status: 503, body: {} } });
    await expect(lookupDoi("10.1/x", { fetch: f })).rejects.toBeInstanceOf(LookupError);
  });
});

const IEEE_HTML = `<html><head><title>IEEE Xplore page</title>
<meta name="citation_title" content="A 10-bit SAR ADC &amp; its calibration">
<meta name="citation_author" content="Kumar, Priya">
<meta name="citation_author" content="Rao, S.">
<meta name="citation_publication_date" content="2022/03/15">
<meta name="citation_journal_title" content="IEEE Journal of Solid-State Circuits">
<meta name="citation_volume" content="57"><meta name="citation_issue" content="3">
<meta name="citation_firstpage" content="801"><meta name="citation_lastpage" content="812">
<meta name="citation_doi" content="10.1109/JSSC.2022.1234567">
<meta name="citation_pdf_url" content="https://example.org/paper.pdf">
</head><body>...</body></html>`;

const BLOG_HTML = `<head><title>Blog</title><meta property="og:title" content="Debugging I2C">
<meta property="og:site_name" content="Embedded Notes">
<script type="application/ld+json">{"@type":"BlogPosting","headline":"Debugging I2C","author":{"@type":"Person","name":"Ana Lima"},"datePublished":"2024-05-02"}</script></head>`;

describe("page metadata", () => {
  it("reads Highwire citation tags", () => {
    const { reference, confidence, pdfUrl } = referenceFromMeta(parseMetaTags(IEEE_HTML), "https://ieeexplore.ieee.org/document/1");
    expect(reference).toMatchObject({
      type: "article-journal",
      title: "A 10-bit SAR ADC & its calibration",
      issued: { "date-parts": [[2022, 3, 15]] },
      page: "801–812",
      DOI: "10.1109/JSSC.2022.1234567",
      author: [{ family: "Kumar", given: "Priya" }, { family: "Rao", given: "S." }],
    });
    expect(confidence).toBe(1);
    expect(pdfUrl).toBe("https://example.org/paper.pdf");
  });
  it("falls back to JSON-LD and OpenGraph for ordinary pages", () => {
    const now = new Date(2026, 9, 29);
    const { reference, confidence } = referenceFromMeta(parseMetaTags(BLOG_HTML), "https://blog.example/i2c", undefined, now);
    expect(reference).toMatchObject({
      type: "post-weblog",
      title: "Debugging I2C",
      "container-title": "Embedded Notes",
      author: [{ family: "Lima", given: "Ana" }],
      issued: { "date-parts": [[2024, 5, 2]] },
    });
    expect(reference.accessed).toBeUndefined();
    expect(confidence).toBeLessThan(1);
    const plain = referenceFromMeta({}, "https://x.example", "Untitled", now).reference;
    expect(plain).toMatchObject({ type: "webpage", title: "Untitled", accessed: { "date-parts": [[2026, 10, 29]] } });
  });
});

describe("captureSource", () => {
  it("stays offline by default", async () => {
    const f = mockFetch({});
    const r = await captureSource({ url: "https://arxiv.org/abs/1706.03762", title: "arXiv", text: "" }, { fetch: f });
    expect(f.calls).toEqual([]);
    expect(r.contacted).toEqual([]);
    expect(r.provenance).toEqual(["page-metadata"]);
  });
  it("uses arXiv when online", async () => {
    const f = mockFetch({ "https://export.arxiv.org/": { body: ATOM } });
    const r = await captureSource({ url: "https://arxiv.org/abs/1706.03762v7" }, { fetch: f, online: true });
    expect(r.provenance).toEqual(["page-metadata", "arxiv"]);
    expect(r.reference.title).toBe("Attention Is All You Need");
    expect(r.pdfUrl).toBe("https://arxiv.org/pdf/1706.03762");
    expect(r.contacted).toEqual(["export.arxiv.org"]);
  });
  it("degrades gracefully when the lookup fails", async () => {
    const f = mockFetch({ "https://api.crossref.org/": { status: 500, body: {} } });
    const r = await captureSource({ url: "https://ieeexplore.ieee.org/document/1", meta: parseMetaTags(IEEE_HTML) }, { fetch: f, online: true });
    expect(r.reference.title).toBe("A 10-bit SAR ADC & its calibration");
    expect(r.warnings[0]).toMatch(/Online lookup failed/);
  });
});
