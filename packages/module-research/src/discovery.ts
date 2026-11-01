import type { Name, Reference, ReferenceType } from "@aether/citations";
import { generateKey, makeDate, normalizeDoi, parseName } from "@aether/citations";
import { crossrefToReference, parseArxivAtom, type CrossrefWork } from "@aether/sources";
import type { DiscoveryHit, DiscoveryService } from "./model.js";
import { NetError, type LabNet } from "./net.js";
import { cleanText, safeUrl, titleKey } from "./text.js";

/**
 * Literature discovery across scholarly indexes. Each adapter maps the
 * service's own response into CSL-JSON, keeps the service's id and link, and
 * returns nothing it did not receive: no inferred authors, years or venues.
 */

export interface DiscoveryQuery {
  text: string;
  fromYear?: number;
  toYear?: number;
  /** Results per service (max 50). */
  limit?: number;
  openAccessOnly?: boolean;
}

export interface ServiceResult {
  service: DiscoveryService;
  hits: DiscoveryHit[];
  total?: number;
  error?: string;
}

export interface ServiceCredentials {
  mailto?: string;
  openalexKey?: string;
  semanticScholarKey?: string;
}

const clampLimit = (n?: number) => Math.max(1, Math.min(50, Math.floor(n ?? 20)));

function finishRef(ref: Reference): Reference {
  // Defensive clean-up of every string field we display.
  if (ref.title) ref.title = cleanText(ref.title, 1000);
  if (ref.abstract) ref.abstract = cleanText(ref.abstract, 20_000);
  if (ref["container-title"]) ref["container-title"] = cleanText(ref["container-title"], 500);
  if (ref.URL) ref.URL = safeUrl(ref.URL);
  if (ref.DOI) ref.DOI = normalizeDoi(ref.DOI) ?? undefined;
  for (const k of Object.keys(ref) as Array<keyof Reference>) if (ref[k] === undefined) delete ref[k];
  if (!ref.id) ref.id = generateKey(ref);
  return ref;
}

export function hitKey(ref: Reference): string {
  const doi = ref.DOI ? normalizeDoi(ref.DOI)?.toLowerCase() : undefined;
  if (doi) return `doi:${doi}`;
  if (ref.archive === "arXiv" && ref.archive_location) return `arxiv:${String(ref.archive_location).replace(/v\d+$/, "")}`;
  return titleKey(ref.title, ref.issued?.["date-parts"]?.[0]?.[0]);
}

// ---------------------------------------------------------------- Crossref

export async function searchCrossref(net: LabNet, q: DiscoveryQuery, cred: ServiceCredentials = {}): Promise<ServiceResult> {
  const p = new URLSearchParams({ "query.bibliographic": q.text, rows: String(clampLimit(q.limit)) });
  const filters: string[] = [];
  if (q.fromYear) filters.push(`from-pub-date:${q.fromYear}`);
  if (q.toYear) filters.push(`until-pub-date:${q.toYear}`);
  if (filters.length) p.set("filter", filters.join(","));
  if (cred.mailto) p.set("mailto", cred.mailto);
  const body = await net.getJson<{ message?: { items?: CrossrefWork[]; "total-results"?: number } }>(`https://api.crossref.org/works?${p}`, { service: "crossref", purpose: "Literature search", sent: q.text });
  const items = body?.message?.items ?? [];
  return {
    service: "crossref",
    total: body?.message?.["total-results"],
    hits: items.filter((w) => w && typeof w.DOI === "string").map((w) => {
      const ref = finishRef(crossrefToReference(w));
      return { key: hitKey(ref), reference: ref, found: [{ service: "crossref" as const, id: ref.DOI, url: ref.DOI ? `https://doi.org/${ref.DOI}` : undefined }], citedBy: numberOr((w as { "is-referenced-by-count"?: unknown })["is-referenced-by-count"]) };
    }),
  };
}

// ---------------------------------------------------------------- OpenAlex

export interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  display_name?: string | null;
  publication_year?: number | null;
  publication_date?: string | null;
  type?: string | null;
  authorships?: Array<{ author?: { display_name?: string | null } }>;
  primary_location?: { source?: { display_name?: string | null } | null; landing_page_url?: string | null } | null;
  open_access?: { is_oa?: boolean; oa_url?: string | null } | null;
  best_oa_location?: { pdf_url?: string | null; landing_page_url?: string | null } | null;
  cited_by_count?: number;
  abstract_inverted_index?: Record<string, number[]> | null;
  is_retracted?: boolean;
  biblio?: { volume?: string | null; issue?: string | null; first_page?: string | null; last_page?: string | null } | null;
  ids?: { doi?: string; arxiv?: string } | null;
  referenced_works?: string[];
  related_works?: string[];
}

const OPENALEX_TYPES: Record<string, ReferenceType> = {
  article: "article-journal",
  "journal-article": "article-journal",
  "proceedings-article": "paper-conference",
  book: "book",
  "book-chapter": "chapter",
  dissertation: "thesis",
  dataset: "dataset",
  preprint: "article",
  report: "report",
  standard: "standard",
};

/** OpenAlex ships abstracts as an inverted index; rebuild the word order. */
export function invertedIndexToText(idx: Record<string, number[]> | null | undefined): string | undefined {
  if (!idx || typeof idx !== "object") return undefined;
  const words: string[] = [];
  let n = 0;
  for (const [word, positions] of Object.entries(idx)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) {
      if (Number.isInteger(p) && p >= 0 && p < 20_000) {
        words[p] = word;
        n++;
      }
    }
    if (n > 20_000) break;
  }
  const text = words.filter((w) => w !== undefined).join(" ");
  return text || undefined;
}

export function openAlexToHit(w: OpenAlexWork): DiscoveryHit | undefined {
  const title = w.title ?? w.display_name ?? undefined;
  if (!title) return undefined;
  const ref: Reference = { id: "", type: OPENALEX_TYPES[w.type ?? ""] ?? "article-journal", title };
  const authors: Name[] = (w.authorships ?? []).map((a) => a.author?.display_name).filter((n): n is string => !!n).slice(0, 100).map((n) => parseName(n));
  if (authors.length) ref.author = authors;
  const [y, m, d] = (w.publication_date ?? "").split("-").map(Number);
  const issued = makeDate(y || w.publication_year || undefined, m || undefined, d || undefined);
  if (issued) ref.issued = issued;
  const venue = w.primary_location?.source?.display_name;
  if (venue) ref["container-title"] = venue;
  if (w.doi) ref.DOI = w.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  if (w.biblio?.volume) ref.volume = w.biblio.volume;
  if (w.biblio?.issue) ref.issue = w.biblio.issue;
  if (w.biblio?.first_page) ref.page = w.biblio.last_page && w.biblio.last_page !== w.biblio.first_page ? `${w.biblio.first_page}–${w.biblio.last_page}` : w.biblio.first_page;
  const landing = safeUrl(w.primary_location?.landing_page_url ?? undefined);
  if (landing) ref.URL = landing;
  const abs = invertedIndexToText(w.abstract_inverted_index);
  if (abs) ref.abstract = abs;
  finishRef(ref);
  const oa = safeUrl(w.best_oa_location?.pdf_url ?? w.open_access?.oa_url ?? undefined);
  return {
    key: hitKey(ref),
    reference: ref,
    found: [{ service: "openalex", id: typeof w.id === "string" ? w.id.replace("https://openalex.org/", "") : undefined, url: safeUrl(w.id ?? undefined) }],
    citedBy: numberOr(w.cited_by_count),
    openAccessUrl: oa,
    isRetracted: w.is_retracted === true ? true : undefined,
  };
}

export async function searchOpenAlex(net: LabNet, q: DiscoveryQuery, cred: ServiceCredentials = {}): Promise<ServiceResult> {
  const p = new URLSearchParams({ search: q.text, "per-page": String(clampLimit(q.limit)) });
  const filters: string[] = [];
  if (q.fromYear) filters.push(`from_publication_date:${q.fromYear}-01-01`);
  if (q.toYear) filters.push(`to_publication_date:${q.toYear}-12-31`);
  if (q.openAccessOnly) filters.push("is_oa:true");
  if (filters.length) p.set("filter", filters.join(","));
  if (cred.mailto) p.set("mailto", cred.mailto);
  if (cred.openalexKey) p.set("api_key", cred.openalexKey);
  const body = await net.getJson<{ results?: OpenAlexWork[]; meta?: { count?: number } }>(`https://api.openalex.org/works?${p}`, { service: "openalex", purpose: "Literature search", sent: q.text });
  return { service: "openalex", total: body?.meta?.count, hits: (body?.results ?? []).map(openAlexToHit).filter((h): h is DiscoveryHit => !!h) };
}

/** Fetch one OpenAlex work by DOI (used by verification for retraction status). */
export async function openAlexByDoi(net: LabNet, doi: string, cred: ServiceCredentials = {}): Promise<DiscoveryHit | undefined> {
  const p = new URLSearchParams();
  if (cred.mailto) p.set("mailto", cred.mailto);
  if (cred.openalexKey) p.set("api_key", cred.openalexKey);
  const qs = p.toString() ? `?${p}` : "";
  try {
    const w = await net.getJson<OpenAlexWork>(`https://api.openalex.org/works/doi:${encodeURIComponent(doi).replace(/%2F/gi, "/")}${qs}`, { service: "openalex", purpose: "Check retraction status", sent: doi });
    return openAlexToHit(w);
  } catch (e) {
    if (e instanceof NetError && e.kind === "not-found") return undefined;
    throw e;
  }
}

// ---------------------------------------------------------------- arXiv

/** arXiv search syntax treats some characters specially; send plain words joined with AND. */
export function arxivSearchQuery(text: string): string {
  const words = text.replace(/["()]/g, " ").split(/\s+/).filter(Boolean).slice(0, 20);
  return words.map((w) => `all:${w}`).join(" AND ");
}

export async function searchArxiv(net: LabNet, q: DiscoveryQuery): Promise<ServiceResult> {
  let sq = arxivSearchQuery(q.text);
  if (q.fromYear || q.toYear) sq += ` AND submittedDate:[${q.fromYear ?? 1991}01010000 TO ${q.toYear ?? 2100}12312359]`;
  const p = new URLSearchParams({ search_query: sq, start: "0", max_results: String(clampLimit(q.limit)) });
  const xml = await net.getText(`https://export.arxiv.org/api/query?${p}`, { service: "arxiv", purpose: "Literature search", sent: q.text });
  const total = Number(xml.match(/<opensearch:totalResults[^>]*>(\d+)</)?.[1]);
  return {
    service: "arxiv",
    total: Number.isFinite(total) ? total : undefined,
    hits: parseArxivAtom(xml).map((r) => {
      const ref = finishRef(r);
      const id = String(ref.archive_location ?? "");
      return { key: hitKey(ref), reference: ref, found: [{ service: "arxiv" as const, id, url: `https://arxiv.org/abs/${id}` }], openAccessUrl: `https://arxiv.org/pdf/${id}` };
    }),
  };
}

// ---------------------------------------------------------------- PubMed (NCBI E-utilities)

interface PubMedSummary {
  uid?: string;
  title?: string;
  authors?: Array<{ name?: string; authtype?: string }>;
  pubdate?: string;
  source?: string;
  fulljournalname?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  pubtype?: string[];
  articleids?: Array<{ idtype?: string; value?: string }>;
}

export function pubmedToHit(d: PubMedSummary): DiscoveryHit | undefined {
  if (!d?.uid || !d.title || !/^\d{1,10}$/.test(d.uid)) return undefined;
  const ref: Reference = { id: "", type: (d.pubtype ?? []).some((t) => /book/i.test(t)) ? "book" : "article-journal", title: d.title.replace(/\.$/, "") };
  // PubMed lists authors as "Surname Initials"; keep that split explicitly.
  const authors = (d.authors ?? []).filter((a) => a.name && (a.authtype ?? "Author") === "Author").slice(0, 100).map((a): Name => {
    const m = a.name!.match(/^(.+?)\s+([A-Z]{1,4})$/);
    return m ? { family: m[1]!, given: m[2]!.split("").join(". ") + "." } : { literal: a.name! };
  });
  if (authors.length) ref.author = authors;
  const y = Number(d.pubdate?.match(/\d{4}/)?.[0]);
  const issued = makeDate(y || undefined);
  if (issued) ref.issued = issued;
  if (d.fulljournalname ?? d.source) ref["container-title"] = d.fulljournalname ?? d.source;
  if (d.volume) ref.volume = d.volume;
  if (d.issue) ref.issue = d.issue;
  if (d.pages) ref.page = d.pages;
  const doi = d.articleids?.find((x) => x.idtype === "doi")?.value;
  if (doi) ref.DOI = doi;
  ref.PMID = d.uid;
  ref.URL = `https://pubmed.ncbi.nlm.nih.gov/${d.uid}/`;
  finishRef(ref);
  const pmc = d.articleids?.find((x) => x.idtype === "pmc")?.value;
  return { key: hitKey(ref), reference: ref, found: [{ service: "pubmed", id: d.uid, url: ref.URL }], openAccessUrl: pmc && /^PMC\d+$/.test(pmc) ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmc}/` : undefined };
}

export async function searchPubMed(net: LabNet, q: DiscoveryQuery): Promise<ServiceResult> {
  let term = q.text;
  if (q.fromYear || q.toYear) term += ` AND ${q.fromYear ?? 1800}:${q.toYear ?? 3000}[dp]`;
  if (q.openAccessOnly) term += " AND free full text[sb]";
  const p = new URLSearchParams({ db: "pubmed", term, retmode: "json", retmax: String(clampLimit(q.limit)), tool: "aether" });
  const s = await net.getJson<{ esearchresult?: { idlist?: string[]; count?: string } }>(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${p}`, { service: "pubmed", purpose: "Literature search", sent: q.text });
  const ids = (s?.esearchresult?.idlist ?? []).filter((x) => /^\d{1,10}$/.test(x));
  const total = Number(s?.esearchresult?.count);
  if (!ids.length) return { service: "pubmed", hits: [], total: Number.isFinite(total) ? total : 0 };
  const sp = new URLSearchParams({ db: "pubmed", id: ids.join(","), retmode: "json", tool: "aether" });
  const sum = await net.getJson<{ result?: Record<string, PubMedSummary> }>(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${sp}`, { service: "pubmed", purpose: "Literature search (details)", sent: `${ids.length} PubMed ids` });
  return { service: "pubmed", total: Number.isFinite(total) ? total : undefined, hits: ids.map((id) => pubmedToHit(sum?.result?.[id] ?? {})).filter((h): h is DiscoveryHit => !!h) };
}

/**
 * Google Scholar has no public API and its terms forbid automated queries, so
 * AETHER only builds a search link the user opens in a normal tab.
 */
export function googleScholarUrl(text: string): string {
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(text.slice(0, 500))}`;
}

// ---------------------------------------------------------------- Semantic Scholar

interface S2Paper {
  paperId?: string;
  externalIds?: { DOI?: string; ArXiv?: string } | null;
  title?: string | null;
  abstract?: string | null;
  venue?: string | null;
  year?: number | null;
  authors?: Array<{ name?: string | null }>;
  citationCount?: number | null;
  url?: string | null;
  openAccessPdf?: { url?: string | null } | null;
  publicationTypes?: string[] | null;
}

export function s2ToHit(p: S2Paper): DiscoveryHit | undefined {
  if (!p.title) return undefined;
  const types = p.publicationTypes ?? [];
  const ref: Reference = { id: "", type: types.includes("Conference") ? "paper-conference" : types.includes("Book") ? "book" : "article-journal", title: p.title };
  const authors = (p.authors ?? []).map((a) => a.name).filter((n): n is string => !!n).slice(0, 100).map((n) => parseName(n));
  if (authors.length) ref.author = authors;
  const issued = makeDate(p.year ?? undefined);
  if (issued) ref.issued = issued;
  if (p.venue) ref["container-title"] = p.venue;
  if (p.externalIds?.DOI) ref.DOI = p.externalIds.DOI;
  if (p.externalIds?.ArXiv) {
    ref.archive = "arXiv";
    ref.archive_location = p.externalIds.ArXiv;
  }
  if (p.abstract) ref.abstract = p.abstract;
  const url = safeUrl(p.url ?? undefined);
  if (url) ref.URL = url;
  finishRef(ref);
  return { key: hitKey(ref), reference: ref, found: [{ service: "semanticscholar", id: p.paperId, url }], citedBy: numberOr(p.citationCount), openAccessUrl: safeUrl(p.openAccessPdf?.url ?? undefined) };
}

export async function searchSemanticScholar(net: LabNet, q: DiscoveryQuery, cred: ServiceCredentials = {}): Promise<ServiceResult> {
  const p = new URLSearchParams({ query: q.text, limit: String(clampLimit(q.limit)), fields: "title,abstract,venue,year,authors,citationCount,url,openAccessPdf,externalIds,publicationTypes" });
  if (q.fromYear || q.toYear) p.set("year", `${q.fromYear ?? ""}-${q.toYear ?? ""}`);
  if (q.openAccessOnly) p.set("openAccessPdf", "");
  const body = await net.getJson<{ data?: S2Paper[]; total?: number }>(`https://api.semanticscholar.org/graph/v1/paper/search?${p}`, {
    service: "semanticscholar",
    purpose: "Literature search",
    sent: q.text,
    headers: cred.semanticScholarKey ? { "x-api-key": cred.semanticScholarKey } : undefined,
  });
  return { service: "semanticscholar", total: body?.total, hits: (body?.data ?? []).map(s2ToHit).filter((h): h is DiscoveryHit => !!h) };
}

// ---------------------------------------------------------------- merge

/**
 * Merge hits from several services into one list. The same work found by two
 * services becomes one hit that lists both. Fields are filled from the first
 * service that supplied them (Crossref first, as the DOI registration agency);
 * nothing is invented to fill gaps.
 */
export function mergeHits(results: ServiceResult[]): DiscoveryHit[] {
  const order: DiscoveryService[] = ["crossref", "openalex", "pubmed", "semanticscholar", "arxiv"];
  const sorted = [...results].sort((a, b) => order.indexOf(a.service) - order.indexOf(b.service));
  const byKey = new Map<string, DiscoveryHit>();
  const aliases = new Map<string, string>();
  const rank = new Map<string, number>();
  for (const r of sorted) {
    r.hits.forEach((h, i) => {
      const tKey = titleKey(h.reference.title, h.reference.issued?.["date-parts"]?.[0]?.[0]);
      const existingKey = byKey.has(h.key) ? h.key : aliases.get(h.key) ?? aliases.get(tKey);
      const score = 1 / (i + 1);
      if (!existingKey) {
        const copy: DiscoveryHit = structuredClone(h);
        byKey.set(h.key, copy);
        aliases.set(tKey, h.key);
        rank.set(h.key, score);
        return;
      }
      const cur = byKey.get(existingKey)!;
      rank.set(existingKey, (rank.get(existingKey) ?? 0) + score);
      for (const f of h.found) if (!cur.found.some((x) => x.service === f.service)) cur.found.push(f);
      for (const [k, v] of Object.entries(h.reference) as Array<[keyof Reference, unknown]>) {
        if (k === "id") continue;
        if ((cur.reference as unknown as Record<string, unknown>)[k] === undefined && v !== undefined) (cur.reference as unknown as Record<string, unknown>)[k] = structuredClone(v);
      }
      cur.citedBy = Math.max(cur.citedBy ?? 0, h.citedBy ?? 0) || undefined;
      cur.openAccessUrl ??= h.openAccessUrl;
      if (h.isRetracted) cur.isRetracted = true;
      if (!aliases.has(h.key)) aliases.set(h.key, existingKey);
    });
  }
  // Works found by more services, and ranked higher by each, come first.
  return [...byKey.entries()].sort((a, b) => (rank.get(b[0]) ?? 0) - (rank.get(a[0]) ?? 0)).map(([, h]) => h);
}

export interface DiscoveryRun {
  query: DiscoveryQuery;
  at: string;
  hits: DiscoveryHit[];
  services: Array<{ service: DiscoveryService; count: number; total?: number; error?: string }>;
}

/** Search the enabled services in parallel; one failing service does not fail the search. */
export async function discover(net: LabNet, q: DiscoveryQuery, services: DiscoveryService[], cred: ServiceCredentials = {}): Promise<DiscoveryRun> {
  const text = q.text.trim();
  if (text.length < 2) throw new NetError("Type at least two characters to search.", "parse");
  const query = { ...q, text: text.slice(0, 500) };
  const runs = services.map(async (s): Promise<ServiceResult> => {
    try {
      if (s === "crossref") return await searchCrossref(net, query, cred);
      if (s === "openalex") return await searchOpenAlex(net, query, cred);
      if (s === "arxiv") return await searchArxiv(net, query);
      if (s === "pubmed") return await searchPubMed(net, query);
      return await searchSemanticScholar(net, query, cred);
    } catch (e) {
      if (e instanceof NetError && e.kind === "offline") throw e;
      return { service: s, hits: [], error: (e as Error).message };
    }
  });
  const results = await Promise.all(runs);
  return {
    query,
    at: new Date().toISOString(),
    hits: mergeHits(results),
    services: results.map((r) => ({ service: r.service, count: r.hits.length, total: r.total, error: r.error })),
  };
}

function numberOr(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}
