import type { Reference } from "@aether/citations";
import { generateKey, makeDate, parseName } from "@aether/citations";
import type { PdfDocument } from "./engine.js";

const DOI_RE = /\b10\.\d{4,9}\/[^\s"'<>]+[^\s"'<>.,;)\]]/;
const ARXIV_RE = /arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?/i;

/**
 * Best-effort reference from a PDF: document info dictionary plus a DOI or
 * arXiv id found on the first two pages. Callers should offer an online
 * lookup (via @aether/sources) to confirm it.
 */
export async function referenceFromPdf(doc: PdfDocument, fileName?: string): Promise<{ reference: Reference; doi?: string; arxivId?: string }> {
  const info = await doc.info();
  const text = [await doc.pageText(1), doc.numPages > 1 ? await doc.pageText(2) : ""].join("\n");
  const doi = text.match(DOI_RE)?.[0];
  const arxiv = text.match(ARXIV_RE)?.[1];
  // Many generators put junk in Title (e.g. "Microsoft Word - draft3.docx").
  const usefulTitle = info.title && !/^(microsoft word|untitled|document\d*)\b|\.(docx?|tex|dvi|pdf)$/i.test(info.title) ? info.title : undefined;
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 8 && l.length < 200 && !/^(arxiv|doi|http)/i.test(l));
  const ref: Reference = {
    id: "",
    type: arxiv ? "article" : "article-journal",
    title: usefulTitle ?? firstLine ?? fileName?.replace(/\.pdf$/i, "") ?? "Untitled PDF",
  };
  if (info.author) ref.author = info.author.split(/\s*(?:;|,\s*and\s+|\band\b|&)\s*/).filter(Boolean).map(parseName);
  if (info.creationDate) ref.issued = makeDate(info.creationDate.getUTCFullYear());
  if (doi) ref.DOI = doi;
  if (arxiv) {
    ref.archive = "arXiv";
    ref["archive_location"] = arxiv;
  }
  ref.id = generateKey(ref);
  return { reference: ref, doi, arxivId: arxiv };
}
