import type { Reference } from "@aether/citations";
import { generateKey, makeDate, parseName } from "@aether/citations";
import { getText, LookupError, type LookupOptions } from "./http.js";

/** Accepts "2101.00001", "2101.00001v2", "arXiv:2101.00001", "hep-th/9901001", or arxiv.org abs/pdf URLs. */
export function parseArxivId(input: string): { id: string; version?: string } | undefined {
  const s = input.trim();
  const m =
    s.match(/(?:arxiv\.org\/(?:abs|pdf|html)\/|arxiv:\s*|^)(\d{4}\.\d{4,5})(v\d+)?(?:\.pdf)?(?=$|[?#/\s])/i) ??
    s.match(/(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*|^)([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?(?:\.pdf)?(?=$|[?#\s])/i);
  if (!m) return undefined;
  return m[2] ? { id: m[1]!, version: m[2] } : { id: m[1]! };
}

const decodeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decodeXml(m[1]!) : undefined;
};

/**
 * Parse the arXiv API Atom feed (https://info.arxiv.org/help/api/user-manual.html).
 * The feed has a fixed, flat structure, so a tag scanner is sufficient and avoids
 * needing a DOM in the main process.
 */
export function parseArxivAtom(xml: string): Reference[] {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return entries.flatMap((e) => {
    const idUrl = tag(e, "id");
    const parsed = idUrl ? parseArxivId(idUrl) : undefined;
    if (!parsed) return [];
    const authors = [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) => parseName(decodeXml(m[1]!)));
    const published = tag(e, "published");
    const [y, mo, d] = (published ?? "").slice(0, 10).split("-").map(Number);
    const doi = tag(e, "arxiv:doi");
    const journalRef = tag(e, "arxiv:journal_ref");
    const category = e.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1];
    const ref: Reference = {
      id: "",
      type: "article",
      title: tag(e, "title"),
      author: authors,
      archive: "arXiv",
      archive_location: parsed.id,
      URL: `https://arxiv.org/abs/${parsed.id}`,
    };
    const issued = makeDate(y, mo, d);
    if (issued) ref.issued = issued;
    const summary = tag(e, "summary");
    if (summary) ref.abstract = summary;
    if (doi) ref.DOI = doi;
    if (journalRef) ref.note = journalRef;
    if (category) ref.keyword = category;
    if (parsed.version) ref.version = parsed.version.slice(1);
    ref.id = generateKey(ref);
    return [ref];
  });
}

export async function lookupArxiv(input: string, opts: LookupOptions = {}): Promise<Reference> {
  const parsed = parseArxivId(input);
  if (!parsed) throw new LookupError(`"${input}" is not an arXiv identifier`, "invalid-input");
  const xml = await getText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(parsed.id)}`, opts);
  const [ref] = parseArxivAtom(xml);
  if (!ref) throw new LookupError(`arXiv has no record for ${parsed.id}`, "not-found");
  return ref;
}
