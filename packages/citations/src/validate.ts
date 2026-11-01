import type { Reference } from "./types.js";
import { dateParts } from "./dates.js";
import { normalizeDoi } from "./styles/common.js";

export interface ReferenceIssue {
  field: keyof Reference | "general";
  severity: "error" | "warning";
  message: string;
}

/**
 * Completeness checks that help writers produce defensible bibliographies:
 * missing authors/dates/venues, malformed DOIs, and web sources with no access date.
 */
export function validateReference(ref: Reference): ReferenceIssue[] {
  const issues: ReferenceIssue[] = [];
  const warn = (field: ReferenceIssue["field"], message: string, severity: ReferenceIssue["severity"] = "warning") =>
    issues.push({ field, message, severity });
  if (!ref.title) warn("title", "Missing title.", "error");
  if (!ref.author?.length && !["webpage", "standard"].includes(ref.type)) warn("author", "No authors; the title will be used in citations.");
  if (!dateParts(ref.issued).year) warn("issued", "No publication year; styles will print “n.d.”.");
  if (ref.DOI && !normalizeDoi(ref.DOI)) warn("DOI", `"${ref.DOI}" does not look like a DOI (expected 10.xxxx/...).`, "error");
  if ((ref.type === "article-journal" || ref.type === "paper-conference") && !ref["container-title"]) warn("container-title", "Missing journal or proceedings title.");
  if (ref.type === "article-journal" && !ref.DOI && !ref.page) warn("page", "Journal article has neither a DOI nor page numbers.");
  if ((ref.type === "webpage" || ref.type === "post-weblog") && !dateParts(ref.accessed).year) warn("accessed", "Web source without an access date.");
  if (ref.type === "book" && !ref.publisher) warn("publisher", "Book without a publisher.");
  if (ref.URL && !/^https?:\/\//i.test(ref.URL)) warn("URL", "URL should start with http:// or https://.", "error");
  return issues;
}

/** Find likely duplicates by DOI, or by normalised title + year. */
export function findDuplicates(refs: Reference[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const seen = new Map<string, string>();
  for (const r of refs) {
    const keys: string[] = [];
    const doi = r.DOI ? normalizeDoi(r.DOI)?.toLowerCase() : undefined;
    if (doi) keys.push(`doi:${doi}`);
    if (r.title) keys.push(`t:${r.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")}:${dateParts(r.issued).year ?? ""}`);
    for (const k of keys) {
      const prev = seen.get(k);
      if (prev && prev !== r.id) {
        pairs.push([prev, r.id]);
        break;
      }
      seen.set(k, r.id);
    }
  }
  return pairs;
}
