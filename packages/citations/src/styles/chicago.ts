import type { Name, Reference, Rich, CiteOptions } from "../types.js";
import { RichBuilder, quoted } from "../rich.js";
import { familyGiven, familyName, givenFamily, joinList } from "../names.js";
import { dateParts, MONTHS_FULL, pageRange } from "../dates.js";
import { doiUrl, editionLabel } from "./common.js";

/** Chicago 17th, author-date: list up to ten authors; for 11+ list seven then "et al." */
export function chicagoAuthors(a: Name[]): string {
  const shown = a.length > 10 ? a.slice(0, 7) : a;
  const list = shown.map((n, i) => (i === 0 ? familyGiven(n) : givenFamily(n)));
  if (a.length > 10) return `${list.join(", ")}, et al.`;
  // The first name is inverted, so even two names take a comma: "Sedra, Adel, and Kenneth Smith".
  if (list.length === 2) return `${list[0]}, and ${list[1]}`;
  return joinList(list, "and", true);
}

/** Chicago Manual of Style, 17th ed., author-date reference list entry. */
export function chicagoReference(ref: Reference, yearSuffix = ""): Rich {
  const b = new RichBuilder();
  const d = dateParts(ref.issued);
  const year = d.year ? `${d.year}${yearSuffix}` : `n.d.${yearSuffix}`;
  if (ref.author?.length) b.add(chicagoAuthors(ref.author)).punct(".").add(` ${year}. `);

  const isPart = ["article-journal", "article-magazine", "article-newspaper", "chapter", "paper-conference", "webpage", "post-weblog"].includes(ref.type);
  if (ref.title) {
    if (isPart) b.add(quoted(ref.title, "."));
    else b.italic(ref.title).punct(".");
  }
  if (!ref.author?.length) b.add(` ${year}.`);

  const container = ref["container-title"];
  switch (ref.type) {
    case "article-journal":
    case "article-magazine":
    case "article-newspaper":
      if (container) {
        b.add(" ").italic(container);
        if (ref.volume) b.add(` ${ref.volume}`);
        if (ref.issue) b.add(` (${ref.issue})`);
        const p = pageRange(ref.page);
        if (p) b.add(`: ${p}`);
        b.add(".");
      }
      break;
    case "chapter":
    case "paper-conference": {
      if (container) {
        b.add(" In ").italic(container);
        if (ref.editor?.length) b.add(`, edited by ${joinList(ref.editor.map(givenFamily), "and")}`);
        const p = pageRange(ref.page);
        if (p) b.add(`, ${p}`);
        b.add(".");
      }
      const pub = [ref["publisher-place"], ref.publisher].filter(Boolean).join(": ");
      if (pub) b.add(` ${pub}.`);
      break;
    }
    case "webpage":
    case "post-weblog": {
      const site = container ?? ref.publisher;
      if (site) b.add(` ${site}.`);
      const acc = dateParts(ref.accessed);
      if (acc.year && !d.year) b.add(` Accessed ${acc.month ? `${MONTHS_FULL[acc.month - 1]} ` : ""}${acc.day ? `${acc.day}, ` : ""}${acc.year}.`);
      break;
    }
    case "thesis":
      b.add(` ${ref.genre ?? "PhD diss."}`);
      if (ref.publisher) b.add(`, ${ref.publisher}`);
      b.add(".");
      break;
    default: {
      const ed = editionLabel(ref.edition);
      if (ed) b.add(` ${ed}`);
      if (ref.number) b.add(` ${ref.number}.`);
      const pub = [ref["publisher-place"], ref.publisher].filter(Boolean).join(": ");
      if (pub) b.add(` ${pub}.`);
    }
  }
  const doi = doiUrl(ref.DOI);
  if (doi) b.add(" ").link(doi, doi).add(".");
  else if (ref.URL) b.add(" ").link(ref.URL, ref.URL).add(".");
  return b.build();
}

export function chicagoCitation(ref: Reference, opts: CiteOptions = {}, yearSuffix = ""): string {
  const a = ref.author ?? [];
  const d = dateParts(ref.issued);
  const year = d.year ? `${d.year}${yearSuffix}` : `n.d.${yearSuffix}`;
  const fam = a.map(familyName);
  const name =
    fam.length === 0 ? `“${ref["title-short"] ?? ref.title ?? "Anonymous"}”` : fam.length === 1 ? fam[0]! : fam.length <= 3 ? joinList(fam, "and", true) : `${fam[0]} et al.`;
  const loc = opts.locator ? `, ${opts.locator.replace(/^pp?\.\s*/, "")}` : "";
  return opts.narrative ? `${name} (${year}${loc})` : `(${name} ${year}${loc})`;
}
