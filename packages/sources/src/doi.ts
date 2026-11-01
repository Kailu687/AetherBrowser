import type { Name, Reference, ReferenceType } from "@aether/citations";
import { generateKey, makeDate, normalizeDoi } from "@aether/citations";
import { getJson, LookupError, type LookupOptions } from "./http.js";

/** Find the first DOI in free text or a URL. */
export function extractDoi(text: string): string | undefined {
  const m = decodeURIComponent(text).match(/\b10\.\d{4,9}\/[^\s"'<>]+/);
  if (!m) return undefined;
  // Trim trailing punctuation and unbalanced closing brackets.
  let doi = m[0].replace(/[.,;:]+$/, "");
  while (/[)\]]$/.test(doi) && (doi.match(/[([]/g)?.length ?? 0) < (doi.match(/[)\]]/g)?.length ?? 0)) doi = doi.slice(0, -1);
  return doi.replace(/\.(pdf|full|abstract)$/i, "");
}

const CROSSREF_TYPES: Record<string, ReferenceType> = {
  "journal-article": "article-journal",
  "proceedings-article": "paper-conference",
  "book-chapter": "chapter",
  "book-section": "chapter",
  book: "book",
  monograph: "book",
  "edited-book": "book",
  "reference-book": "book",
  report: "report",
  dissertation: "thesis",
  dataset: "dataset",
  standard: "standard",
  "posted-content": "article",
};

interface CrossrefName {
  family?: string;
  given?: string;
  name?: string;
  suffix?: string;
}
interface CrossrefDate {
  "date-parts"?: number[][];
}
export interface CrossrefWork {
  DOI: string;
  type?: string;
  title?: string[];
  subtitle?: string[];
  author?: CrossrefName[];
  editor?: CrossrefName[];
  "container-title"?: string[];
  "short-container-title"?: string[];
  issued?: CrossrefDate;
  "published-print"?: CrossrefDate;
  "published-online"?: CrossrefDate;
  volume?: string;
  issue?: string;
  page?: string;
  publisher?: string;
  "publisher-location"?: string;
  ISBN?: string[];
  ISSN?: string[];
  URL?: string;
  abstract?: string;
  event?: { name?: string; location?: string };
}

const names = (list?: CrossrefName[]): Name[] | undefined =>
  list?.length ? list.map((n) => (n.family ? { family: n.family, ...(n.given ? { given: n.given } : {}), ...(n.suffix ? { suffix: n.suffix } : {}) } : { literal: n.name ?? "" })) : undefined;

/** Strip JATS XML tags Crossref uses in abstracts. */
export const stripJats = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export function crossrefToReference(w: CrossrefWork, taken?: Set<string>): Reference {
  const date = (w.issued ?? w["published-print"] ?? w["published-online"])?.["date-parts"]?.[0];
  const title = [w.title?.[0], w.subtitle?.[0]].filter(Boolean).join(": ");
  const ref: Reference = { id: "", type: CROSSREF_TYPES[w.type ?? ""] ?? "article-journal", DOI: w.DOI };
  if (title) ref.title = title;
  const a = names(w.author);
  if (a) ref.author = a;
  const e = names(w.editor);
  if (e) ref.editor = e;
  const issued = date ? makeDate(date[0], date[1], date[2]) : undefined;
  if (issued) ref.issued = issued;
  const set = (k: keyof Reference, v: string | undefined) => {
    if (v) (ref as unknown as Record<string, string>)[k] = v;
  };
  set("container-title", w["container-title"]?.[0] ?? w.event?.name);
  set("container-title-short", w["short-container-title"]?.[0]);
  set("volume", w.volume);
  set("issue", w.issue);
  set("page", w.page?.replace(/-/g, "–"));
  set("publisher", w.publisher);
  set("publisher-place", w["publisher-location"]);
  set("event-place", w.event?.location);
  set("ISBN", w.ISBN?.[0]);
  set("ISSN", w.ISSN?.[0]);
  set("URL", w.URL);
  if (w.abstract) ref.abstract = stripJats(w.abstract);
  ref.id = generateKey(ref, taken);
  return ref;
}

/** Look up a DOI on Crossref; falls back to doi.org CSL-JSON content negotiation (covers DataCite DOIs). */
export async function lookupDoi(input: string, opts: LookupOptions = {}): Promise<Reference> {
  const doi = normalizeDoi(input) ?? extractDoi(input);
  if (!doi) throw new LookupError(`"${input}" is not a DOI`, "invalid-input");
  const q = opts.mailto ? `?mailto=${encodeURIComponent(opts.mailto)}` : "";
  try {
    const body = (await getJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}${q}`, opts)) as { message?: CrossrefWork };
    if (!body?.message) throw new LookupError("Unexpected Crossref response", "parse");
    return crossrefToReference(body.message);
  } catch (e) {
    if (!(e instanceof LookupError) || e.kind !== "not-found") throw e;
    const csl = (await getJson(`https://doi.org/${doi}`, opts, { Accept: "application/vnd.citationstyles.csl+json" })) as Reference;
    return { ...csl, id: generateKey(csl), DOI: doi };
  }
}
