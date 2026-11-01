import type { Reference } from "@aether/citations";
import { lookupArxiv, parseArxivId } from "./arxiv.js";
import { extractDoi, lookupDoi } from "./doi.js";
import { referenceFromMeta, type MetaMap } from "./meta.js";
import { LookupError, type LookupOptions } from "./http.js";

/** What the shell's isolated-world extractor returns for a tab (host.tabs.getPageContent). */
export interface PageContent {
  url: string;
  title?: string;
  text?: string;
  meta?: MetaMap;
}

export type SourceProvenance = "page-metadata" | "crossref" | "doi.org" | "arxiv" | "manual";

export interface CaptureResult {
  reference: Reference;
  provenance: SourceProvenance[];
  confidence: number;
  pdfUrl?: string;
  /** Hosts contacted during capture, for the privacy log. Empty when offline. */
  contacted: string[];
  warnings: string[];
}

export interface CaptureOptions extends LookupOptions {
  /**
   * Allow network lookups to arXiv/Crossref. Off by default: AETHER only uses
   * metadata already present on the page unless the user enables lookups.
   */
  online?: boolean;
  now?: Date;
}

/**
 * Turn the current page into a citable reference. Page metadata is always
 * used first; if online lookups are enabled and an arXiv id or DOI is found,
 * the authoritative record is fetched and merged over it.
 */
export async function captureSource(page: PageContent, opts: CaptureOptions = {}): Promise<CaptureResult> {
  const base = referenceFromMeta(page.meta ?? {}, page.url, page.title, opts.now);
  const result: CaptureResult = {
    reference: base.reference,
    provenance: ["page-metadata"],
    confidence: base.confidence,
    pdfUrl: base.pdfUrl,
    contacted: [],
    warnings: [],
  };

  const arxiv = parseArxivId(page.url) ?? (base.reference["archive_location"] ? parseArxivId(base.reference["archive_location"]) : undefined);
  const doi = base.reference.DOI ?? extractDoi(page.url) ?? (page.text ? extractDoi(page.text.slice(0, 5000)) : undefined);

  if (!opts.online) {
    if (doi && !base.reference.DOI) result.warnings.push(`Found DOI ${doi} in the page text; enable online lookup to verify it.`);
    if (doi && !base.reference.DOI) result.reference.DOI = doi;
    return result;
  }

  try {
    if (arxiv) {
      result.contacted.push("export.arxiv.org");
      const r = await lookupArxiv(arxiv.id, opts);
      result.reference = merge(base.reference, r);
      result.provenance.push("arxiv");
      result.confidence = 1;
      result.pdfUrl ??= `https://arxiv.org/pdf/${arxiv.id}`;
    } else if (doi) {
      result.contacted.push("api.crossref.org");
      const r = await lookupDoi(doi, opts);
      result.reference = merge(base.reference, r);
      result.provenance.push("crossref");
      result.confidence = 1;
    }
  } catch (e) {
    const msg = e instanceof LookupError ? e.message : String(e);
    result.warnings.push(`Online lookup failed, using page metadata only: ${msg}`);
  }
  return result;
}

/** Authoritative fields win; page-only fields (abstract, URL, PDF) are kept when the lookup lacks them. */
function merge(page: Reference, auth: Reference): Reference {
  const out: Reference = { ...page };
  for (const [k, v] of Object.entries(auth)) {
    if (v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) (out as unknown as Record<string, unknown>)[k] = v;
  }
  if (page.type === "webpage" && auth.type) out.type = auth.type;
  if (out.type !== "webpage") delete out.accessed;
  return out;
}

/** Resolve a user-typed identifier: DOI, arXiv id, or a URL containing either. */
export async function lookupIdentifier(input: string, opts: LookupOptions = {}): Promise<{ reference: Reference; provenance: SourceProvenance }> {
  const arxiv = parseArxivId(input);
  if (arxiv) return { reference: await lookupArxiv(arxiv.id, opts), provenance: "arxiv" };
  if (extractDoi(input)) return { reference: await lookupDoi(input, opts), provenance: "crossref" };
  throw new LookupError(`Could not recognise "${input}" as a DOI or arXiv identifier`, "invalid-input");
}
