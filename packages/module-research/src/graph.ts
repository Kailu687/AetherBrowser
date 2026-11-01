import type { Reference } from "@aether/citations";
import { normalizeDoi } from "@aether/citations";
import type { DiscoveryHit } from "./model.js";
import { openAlexToHit, type OpenAlexWork, type ServiceCredentials } from "./discovery.js";
import { NetError, type LabNet } from "./net.js";

/**
 * Citation graph, topic timeline and related-paper suggestions, all from
 * OpenAlex metadata. Every suggestion says *why* it is suggested (which of
 * the user's sources cite it or are cited by it), so nothing is a black box.
 */

const OA_ID = /^W\d{1,12}$/;
const shortId = (u: string | undefined) => (u ? u.replace("https://openalex.org/", "") : "");

function qs(cred: ServiceCredentials, extra: Record<string, string> = {}) {
  const p = new URLSearchParams(extra);
  if (cred.mailto) p.set("mailto", cred.mailto);
  if (cred.openalexKey) p.set("api_key", cred.openalexKey);
  return p.toString();
}

const SELECT = "id,doi,title,display_name,publication_year,publication_date,type,authorships,primary_location,cited_by_count,referenced_works,is_retracted,best_oa_location,open_access,biblio";

async function workByDoi(net: LabNet, doi: string, cred: ServiceCredentials): Promise<OpenAlexWork | undefined> {
  try {
    return await net.getJson<OpenAlexWork>(`https://api.openalex.org/works/doi:${encodeURIComponent(doi).replace(/%2F/gi, "/")}?${qs(cred, { select: SELECT })}`, { service: "openalex", purpose: "Citation graph", sent: doi });
  } catch (e) {
    if (e instanceof NetError && e.kind === "not-found") return undefined;
    throw e;
  }
}

async function worksByIds(net: LabNet, ids: string[], cred: ServiceCredentials): Promise<OpenAlexWork[]> {
  const out: OpenAlexWork[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50).filter((x) => OA_ID.test(x));
    if (!chunk.length) continue;
    const body = await net.getJson<{ results?: OpenAlexWork[] }>(`https://api.openalex.org/works?${qs(cred, { filter: `openalex:${chunk.join("|")}`, "per-page": "50", select: SELECT })}`, { service: "openalex", purpose: "Citation graph (details)", sent: `${chunk.length} OpenAlex ids` });
    out.push(...(body?.results ?? []));
  }
  return out;
}

export interface GraphNode {
  id: string;
  /** Library key when the node is one of the user's sources. */
  refId?: string;
  title: string;
  year?: number;
  citedBy?: number;
  inProject: boolean;
}

export interface CitationGraph {
  nodes: GraphNode[];
  /** from cites to. */
  edges: Array<{ from: string; to: string }>;
  /** Project sources that could not be found in OpenAlex (no DOI, or not indexed). */
  unresolved: string[];
  suggestions: RelatedSuggestion[];
  source: "OpenAlex";
  builtAt: string;
}

export interface RelatedSuggestion {
  hit: DiscoveryHit;
  /** Human-readable reasons, e.g. "Cited by 3 of your sources: Kumar (2022), …". */
  reasons: string[];
  score: number;
  citedByProject: string[];
  citesProject: string[];
}

/**
 * Build the citation graph for a project's sources and suggest related works.
 * Requests: one per source with a DOI, plus batched lookups. Capped at 60
 * sources to stay within the services' fair-use limits.
 */
export async function citationGraph(net: LabNet, sources: Reference[], cred: ServiceCredentials = {}, opts: { maxSources?: number; label?: (r: Reference) => string } = {}): Promise<CitationGraph> {
  const label = opts.label ?? ((r: Reference) => r.title ?? r.id);
  const capped = sources.slice(0, opts.maxSources ?? 60);
  const unresolved: string[] = [];
  const mine = new Map<string, { ref: Reference; work: OpenAlexWork }>();
  for (const r of capped) {
    const doi = r.DOI ? normalizeDoi(r.DOI) : undefined;
    if (!doi) {
      unresolved.push(r.id);
      continue;
    }
    const w = await workByDoi(net, doi, cred);
    const wid = shortId(w?.id);
    if (!w || !OA_ID.test(wid)) unresolved.push(r.id);
    else mine.set(wid, { ref: r, work: w });
  }
  for (const r of sources.slice(capped.length)) unresolved.push(r.id);

  const nodes = new Map<string, GraphNode>();
  const edges: Array<{ from: string; to: string }> = [];
  for (const [wid, { ref, work }] of mine) nodes.set(wid, { id: wid, refId: ref.id, title: ref.title ?? work.title ?? wid, year: work.publication_year ?? undefined, citedBy: work.cited_by_count, inProject: true });

  // Works cited by the user's sources.
  const citedCount = new Map<string, string[]>();
  for (const [wid, { work }] of mine) {
    for (const ref of (work.referenced_works ?? []).slice(0, 500)) {
      const rid = shortId(ref);
      if (!OA_ID.test(rid)) continue;
      edges.push({ from: wid, to: rid });
      if (!mine.has(rid)) citedCount.set(rid, [...(citedCount.get(rid) ?? []), wid]);
    }
  }
  // Works that cite the user's sources (one page per source, most-cited first).
  const citingCount = new Map<string, string[]>();
  const citingWorks = new Map<string, OpenAlexWork>();
  for (const wid of [...mine.keys()].slice(0, 30)) {
    const body = await net.getJson<{ results?: OpenAlexWork[] }>(`https://api.openalex.org/works?${qs(cred, { filter: `cites:${wid}`, sort: "cited_by_count:desc", "per-page": "25", select: SELECT })}`, { service: "openalex", purpose: "Citing works", sent: wid });
    for (const w of body?.results ?? []) {
      const cid = shortId(w.id);
      if (!OA_ID.test(cid)) continue;
      edges.push({ from: cid, to: wid });
      if (!mine.has(cid)) {
        citingCount.set(cid, [...(citingCount.get(cid) ?? []), wid]);
        citingWorks.set(cid, w);
      }
    }
  }

  // Suggestions: works linked to at least two of the user's sources.
  const candidates = new Set([...citedCount.keys(), ...citingCount.keys()].filter((id) => (citedCount.get(id)?.length ?? 0) + (citingCount.get(id)?.length ?? 0) >= 2));
  const need = [...candidates].filter((id) => !citingWorks.has(id)).slice(0, 100);
  const details = new Map((await worksByIds(net, need, cred)).map((w) => [shortId(w.id), w]));
  for (const [id, w] of citingWorks) details.set(id, w);
  const nameOf = (wid: string) => label(mine.get(wid)!.ref);
  const suggestions: RelatedSuggestion[] = [];
  for (const id of candidates) {
    const w = details.get(id);
    const hit = w ? openAlexToHit(w) : undefined;
    if (!hit) continue;
    const by = [...new Set(citedCount.get(id) ?? [])];
    const cites = [...new Set(citingCount.get(id) ?? [])];
    const reasons: string[] = [];
    if (by.length) reasons.push(`Cited by ${by.length} of your sources: ${by.slice(0, 4).map(nameOf).join("; ")}${by.length > 4 ? "; …" : ""}`);
    if (cites.length) reasons.push(`Cites ${cites.length} of your sources: ${cites.slice(0, 4).map(nameOf).join("; ")}${cites.length > 4 ? "; …" : ""}`);
    suggestions.push({ hit, reasons, score: by.length + cites.length, citedByProject: by.map((x) => mine.get(x)!.ref.id), citesProject: cites.map((x) => mine.get(x)!.ref.id) });
    nodes.set(id, { id, title: hit.reference.title ?? id, year: w?.publication_year ?? undefined, citedBy: hit.citedBy, inProject: false });
  }
  suggestions.sort((a, b) => b.score - a.score || (b.hit.citedBy ?? 0) - (a.hit.citedBy ?? 0));
  // Keep only edges between nodes we show.
  const shown = new Set(nodes.keys());
  const seen = new Set<string>();
  const kept = edges.filter((e) => shown.has(e.from) && shown.has(e.to) && !seen.has(`${e.from}>${e.to}`) && seen.add(`${e.from}>${e.to}`));
  return { nodes: [...nodes.values()], edges: kept, unresolved, suggestions: suggestions.slice(0, 40), source: "OpenAlex", builtAt: new Date().toISOString() };
}

export interface TopicTimeline {
  query: string;
  years: Array<{ year: number; count: number }>;
  source: "OpenAlex";
  note: string;
}

/** Works per publication year for a search, from OpenAlex's group_by. */
export async function topicTimeline(net: LabNet, text: string, cred: ServiceCredentials = {}): Promise<TopicTimeline> {
  const body = await net.getJson<{ group_by?: Array<{ key?: string; count?: number }> }>(`https://api.openalex.org/works?${qs(cred, { search: text.slice(0, 300), group_by: "publication_year" })}`, { service: "openalex", purpose: "Topic timeline", sent: text });
  const years = (body?.group_by ?? [])
    .map((g) => ({ year: Number(g.key), count: Number(g.count) }))
    .filter((g) => Number.isInteger(g.year) && g.year > 1500 && g.year < 2200 && Number.isFinite(g.count))
    .sort((a, b) => a.year - b.year);
  return { query: text, years, source: "OpenAlex", note: "Counts of works matching the search terms in OpenAlex, by publication year. Indexing coverage changes over time, so treat trends as indicative." };
}

/** Timeline of the user's own project sources by year (offline). */
export function projectTimeline(sources: Reference[]): Array<{ year: number; ids: string[] }> {
  const by = new Map<number, string[]>();
  for (const r of sources) {
    const y = Number(r.issued?.["date-parts"]?.[0]?.[0]);
    if (!Number.isInteger(y)) continue;
    by.set(y, [...(by.get(y) ?? []), r.id]);
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([year, ids]) => ({ year, ids }));
}
