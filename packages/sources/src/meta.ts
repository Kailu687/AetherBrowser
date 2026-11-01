import type { Reference, ReferenceType } from "@aether/citations";
import { generateKey, makeDate, parseDateString, parseName, normalizeDoi } from "@aether/citations";
import { extractDoi } from "./doi.js";

/** Meta tags keyed by lower-cased name/property; repeated tags (citation_author) become arrays. */
export type MetaMap = Record<string, string | string[]>;

/**
 * Extract <meta name|property content> pairs from HTML. Used when the shell
 * hands over raw HTML; the shell's isolated-world extractor already returns a MetaMap.
 */
export function parseMetaTags(html: string): MetaMap {
  const out: MetaMap = {};
  const head = html.slice(0, html.search(/<\/head>/i) >= 0 ? html.search(/<\/head>/i) : 200_000);
  for (const m of head.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries(
      [...m[1]!.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((a) => [a[1]!.toLowerCase(), decodeEntities(a[3] ?? a[4] ?? a[5] ?? "")]),
    );
    const key = (attrs.name ?? attrs.property ?? attrs.itemprop)?.toLowerCase();
    if (!key || attrs.content === undefined) continue;
    const prev = out[key];
    out[key] = prev === undefined ? attrs.content : Array.isArray(prev) ? [...prev, attrs.content] : [prev, attrs.content];
  }
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (title && !out["title"]) out["title"] = decodeEntities(title.trim());
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const prev = out["__jsonld"];
    out["__jsonld"] = prev === undefined ? m[1]!.trim() : [...(Array.isArray(prev) ? prev : [prev]), m[1]!.trim()];
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const first = (m: MetaMap, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = m[k];
    const s = Array.isArray(v) ? v[0] : v;
    if (s && s.trim()) return s.trim();
  }
  return undefined;
};
const all = (m: MetaMap, ...keys: string[]): string[] => {
  for (const k of keys) {
    const v = m[k];
    if (v) return (Array.isArray(v) ? v : [v]).map((s) => s.trim()).filter(Boolean);
  }
  return [];
};

export interface MetaExtraction {
  reference: Reference;
  /** 0–1: how much scholarly metadata the page exposed. */
  confidence: number;
  pdfUrl?: string;
}

/**
 * Build a reference from page metadata: Highwire Press `citation_*` tags
 * (used by Google Scholar, IEEE Xplore, ACM, Springer, arXiv), Dublin Core,
 * Schema.org JSON-LD, then OpenGraph as a last resort for ordinary web pages.
 */
export function referenceFromMeta(meta: MetaMap, pageUrl: string, pageTitle?: string, accessed: Date = new Date()): MetaExtraction {
  const ld = parseJsonLd(meta["__jsonld"]);
  const scholarly = !!first(meta, "citation_title");
  const journal = first(meta, "citation_journal_title");
  const conference = first(meta, "citation_conference_title");
  const book = first(meta, "citation_book_title", "citation_inbook_title");
  const thesis = first(meta, "citation_dissertation_institution");
  const report = first(meta, "citation_technical_report_institution");
  const type: ReferenceType = journal ? "article-journal" : conference ? "paper-conference" : book ? "chapter" : thesis ? "thesis" : report ? "report" : scholarly ? "article" : ld?.type ?? "webpage";

  const authorStrings = all(meta, "citation_author", "dc.creator", "dc.contributor", "author", "article:author");
  const author = authorStrings.length ? authorStrings.flatMap((s) => (authorStrings.length === 1 && s.includes(";") ? s.split(";") : [s])).map((s) => parseName(s)) : ld?.authors;
  const dateStr = first(meta, "citation_publication_date", "citation_date", "citation_online_date", "dc.date", "article:published_time", "date") ?? ld?.date;
  const d = dateStr ? parseDateString(dateStr.replace(/\//g, "-")) : {};
  const doiRaw = first(meta, "citation_doi", "dc.identifier", "prism.doi") ?? extractDoi(pageUrl);
  const doi = doiRaw ? normalizeDoi(doiRaw) : undefined;
  const fp = first(meta, "citation_firstpage");
  const lp = first(meta, "citation_lastpage");

  const ref: Reference = { id: "", type };
  const set = (k: keyof Reference, v: string | undefined) => {
    if (v) (ref as unknown as Record<string, string>)[k] = v;
  };
  set("title", first(meta, "citation_title", "dc.title", "og:title", "twitter:title") ?? ld?.title ?? pageTitle);
  if (author?.length) ref.author = author;
  const issued = makeDate(d.year, d.month, d.day);
  if (issued) ref.issued = issued;
  set("container-title", journal ?? conference ?? book ?? (type === "webpage" || type === "post-weblog" ? first(meta, "og:site_name", "application-name") : undefined));
  set("volume", first(meta, "citation_volume", "prism.volume"));
  set("issue", first(meta, "citation_issue", "prism.number"));
  if (fp) ref.page = lp && lp !== fp ? `${fp}–${lp}` : fp;
  set("publisher", first(meta, "citation_publisher", "dc.publisher") ?? thesis ?? report);
  set("number", first(meta, "citation_technical_report_number"));
  set("ISSN", first(meta, "citation_issn", "prism.issn"));
  set("ISBN", first(meta, "citation_isbn"));
  set("abstract", first(meta, "citation_abstract", "dc.description", "description", "og:description"));
  set("DOI", doi);
  set("language", first(meta, "citation_language", "dc.language"));
  const arxiv = first(meta, "citation_arxiv_id");
  if (arxiv) {
    ref.archive = "arXiv";
    ref["archive_location"] = arxiv;
  }
  ref.URL = first(meta, "citation_abstract_html_url", "og:url") ?? pageUrl;
  if (type === "webpage") ref.accessed = makeDate(accessed.getFullYear(), accessed.getMonth() + 1, accessed.getDate())!;
  ref.id = generateKey(ref);

  const signals = [scholarly, !!author?.length, !!issued, !!doi, !!(journal ?? conference ?? book)].filter(Boolean).length;
  return { reference: ref, confidence: signals / 5, pdfUrl: first(meta, "citation_pdf_url") };
}

interface LdInfo {
  type?: ReferenceType;
  title?: string;
  authors?: ReturnType<typeof parseName>[];
  date?: string;
}

function parseJsonLd(raw: string | string[] | undefined): LdInfo | undefined {
  if (!raw) return undefined;
  for (const block of Array.isArray(raw) ? raw : [raw]) {
    let data: unknown;
    try {
      data = JSON.parse(block);
    } catch {
      continue;
    }
    const nodes = (Array.isArray(data) ? data : [data]).flatMap((n: any) => (n?.["@graph"] ? n["@graph"] : [n]));
    for (const n of nodes as any[]) {
      const t = ([] as string[]).concat(n?.["@type"] ?? []);
      const kind: ReferenceType | undefined = t.includes("ScholarlyArticle")
        ? "article-journal"
        : t.some((x) => ["Article", "NewsArticle", "BlogPosting", "TechArticle"].includes(x))
          ? t.includes("BlogPosting") ? "post-weblog" : "webpage"
          : t.includes("Book")
            ? "book"
            : t.includes("Dataset")
              ? "dataset"
              : undefined;
      if (!kind) continue;
      const authors = ([] as any[]).concat(n.author ?? []).map((a) => (typeof a === "string" ? a : a?.name)).filter(Boolean).map((s: string) => (n.author?.["@type"] === "Organization" ? { literal: s } : parseName(s)));
      return { type: kind, title: n.headline ?? n.name, authors: authors.length ? authors : undefined, date: n.datePublished };
    }
  }
  return undefined;
}
