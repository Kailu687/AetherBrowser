import type { Reference } from "../types.js";

export function doiUrl(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const bare = normalizeDoi(doi);
  return bare ? `https://doi.org/${bare}` : undefined;
}

/** Strip resolver prefixes and "doi:" labels; returns undefined if it is not a DOI. */
export function normalizeDoi(doi: string): string | undefined {
  const m = doi.trim().match(/10\.\d{4,9}\/\S+/);
  return m ? m[0].replace(/[.,;]+$/, "") : undefined;
}

export function arxivId(ref: Reference): string | undefined {
  if (ref.archive?.toLowerCase() === "arxiv" && ref["archive_location"]) return ref["archive_location"];
  const fromUrl = ref.URL?.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:[?#]|$)/i);
  if (fromUrl) return fromUrl[1];
  const fromDoi = ref.DOI?.match(/10\.48550\/arXiv\.(.+)$/i);
  return fromDoi?.[1];
}

export const isPreprint = (ref: Reference) =>
  !!arxivId(ref) && (ref.type === "article" || ref.type === "manuscript" || !ref["container-title"]);

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

/** "2" → "2nd ed."; "Revised" → "Revised ed." */
export function editionLabel(edition: string | number | undefined, abbr = "ed."): string | undefined {
  if (edition === undefined || edition === "") return undefined;
  const n = typeof edition === "number" ? edition : parseInt(edition, 10);
  if (Number.isFinite(n) && String(n) === String(edition).trim()) {
    return n === 1 ? undefined : `${ordinal(n)} ${abbr}`;
  }
  return `${edition} ${abbr}`;
}
