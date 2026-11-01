import type { Name, Reference, Rich } from "../types.js";
import { RichBuilder, quoted } from "../rich.js";
import { initialsFamily, joinList } from "../names.js";
import { dateParts, MONTHS_IEEE, pageRange, isPageRange } from "../dates.js";
import { arxivId, editionLabel, isPreprint, normalizeDoi } from "./common.js";

/** IEEE: up to six authors listed, otherwise first author "et al." */
export function ieeeAuthors(names: Name[]): string {
  if (names.length > 6) return `${initialsFamily(names[0]!)} et al.`;
  return joinList(names.map(initialsFamily), "and", names.length > 2);
}

function ieeeDate(ref: Reference, withMonth = true): string | undefined {
  const d = dateParts(ref.issued);
  if (!d.year) return undefined;
  if (withMonth && d.month) return `${MONTHS_IEEE[d.month - 1]}${d.day ? ` ${d.day},` : ""} ${d.year}`;
  return String(d.year);
}

function pages(ref: Reference): string | undefined {
  const p = pageRange(ref.page);
  if (!p) return undefined;
  return `${isPageRange(ref.page) ? "pp." : "p."} ${p}`;
}

/** IEEE reference body (without the "[n]" label). */
export function ieeeReference(ref: Reference): Rich {
  const b = new RichBuilder();
  const authors = ref.author?.length ? ieeeAuthors(ref.author) : undefined;
  const container = ref["container-title-short"] ?? ref["container-title"];
  const doi = ref.DOI ? normalizeDoi(ref.DOI) : undefined;

  const lead = (sep: string) => {
    if (authors) b.add(authors).add(sep);
  };

  switch (ref.type) {
    case "book": {
      lead(", ");
      b.italic(ref.title);
      const ed = editionLabel(ref.edition);
      if (ed) b.add(`, ${ed}`);
      b.punct(".").add(" ");
      const pub = [ref["publisher-place"], ref.publisher].filter(Boolean).join(": ");
      if (pub) b.add(`${pub}, `);
      b.add(ieeeDate(ref, false) ?? "n.d.");
      break;
    }
    case "chapter": {
      lead(", ");
      b.add(quoted(ref.title ?? "", ",")).add(" in ").italic(ref["container-title"]);
      if (ref.editor?.length) b.add(`, ${joinList(ref.editor.map(initialsFamily), "and")}, ${ref.editor.length > 1 ? "Eds." : "Ed."}`);
      b.add(" ");
      const pub = [ref["publisher-place"], ref.publisher].filter(Boolean).join(": ");
      if (pub) b.add(`${pub}, `);
      b.add(ieeeDate(ref, false) ?? "n.d.");
      const p = pages(ref);
      if (p) b.add(`, ${p}`);
      break;
    }
    case "paper-conference": {
      lead(", ");
      b.add(quoted(ref.title ?? "", ",")).add(" in ").italic(container ?? ref["event-title"]);
      const place = ref["event-place"] ?? ref["publisher-place"];
      if (place) b.add(`, ${place}`);
      const date = ieeeDate(ref);
      if (date) b.add(`, ${date}`);
      const p = pages(ref);
      if (p) b.add(`, ${p}`);
      break;
    }
    case "thesis": {
      lead(", ");
      b.add(quoted(ref.title ?? "", ","));
      const kind = /master/i.test(ref.genre ?? "") ? "M.S. thesis" : /bachelor|b\.?tech|undergrad/i.test(ref.genre ?? "") ? "B.Tech. thesis" : "Ph.D. dissertation";
      b.add(` ${kind}`);
      if (ref.publisher) b.add(`, ${ref.publisher}`);
      if (ref["publisher-place"]) b.add(`, ${ref["publisher-place"]}`);
      b.add(`, ${ieeeDate(ref, false) ?? "n.d."}`);
      break;
    }
    case "report": {
      lead(", ");
      b.add(quoted(ref.title ?? "", ","));
      if (ref.publisher) b.add(` ${ref.publisher}`);
      if (ref["publisher-place"]) b.add(`, ${ref["publisher-place"]}`);
      if (ref.number) b.add(`, ${ref.genre ? ref.genre : "Rep."} ${ref.number}`);
      const date = ieeeDate(ref);
      if (date) b.add(`, ${date}`);
      break;
    }
    case "standard": {
      b.italic(ref.title);
      if (ref.number) b.add(`, ${ref.number}`);
      b.add(`, ${ieeeDate(ref, false) ?? "n.d."}`);
      break;
    }
    case "patent": {
      lead(", ");
      b.add(quoted(ref.title ?? "", ","));
      if (ref.number) b.add(` ${ref.number}`);
      const date = ieeeDate(ref);
      if (date) b.add(`, ${date}`);
      break;
    }
    case "webpage":
    case "post-weblog":
    case "software":
    case "dataset": {
      if (authors) b.add(authors).add(". ");
      b.add(quoted(ref.title ?? "", ".")).add(" ");
      const site = ref["container-title"] ?? ref.publisher;
      if (site) b.add(`${site}. `);
      if (ref.version) b.add(`Version ${ref.version}. `);
      if (ref.URL) b.link(ref.URL, ref.URL);
      const acc = dateParts(ref.accessed);
      if (acc.year) {
        const m = acc.month ? `${MONTHS_IEEE[acc.month - 1]} ` : "";
        b.add(` (accessed ${m}${acc.day ? `${acc.day}, ` : ""}${acc.year})`);
      }
      if (doi) b.add(`, doi: ${doi}`);
      b.punct(".");
      return b.build();
    }
    default: {
      // Journal / magazine articles and preprints.
      lead(", ");
      b.add(quoted(ref.title ?? "", ","));
      const id = arxivId(ref);
      if (isPreprint(ref) && id) {
        b.add(` ${ieeeDate(ref, false) ?? "n.d."}, `).italic(`arXiv:${id}`);
      } else {
        b.add(" ").italic(container);
        if (ref.volume) b.add(`, vol. ${ref.volume}`);
        if (ref.issue) b.add(`, no. ${ref.issue}`);
        const p = pages(ref);
        if (p) b.add(`, ${p}`);
        const date = ieeeDate(ref);
        if (date) b.add(`, ${date}`);
      }
    }
  }
  if (doi) b.add(`, doi: ${doi}`);
  else if (ref.URL && ref.type !== "book") b.add(". [Online]. Available: ").link(ref.URL, ref.URL);
  if (!/^https?:/.test(b.parts[b.parts.length - 1]?.href ?? "")) b.punct(".");
  return b.build();
}

export function ieeeCitation(numbers: number[]): string {
  // Collapse consecutive numbers: [1]–[3], [5]
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const groups: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    groups.push(j - i >= 2 ? `[${sorted[i]}]–[${sorted[j]}]` : sorted.slice(i, j + 1).map((n) => `[${n}]`).join(", "));
    i = j + 1;
  }
  return groups.join(", ");
}
