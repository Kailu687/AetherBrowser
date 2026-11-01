import type { Name, Reference, Rich, CiteOptions } from "../types.js";
import { RichBuilder } from "../rich.js";
import { familyInitials, familyName, initialsFamily } from "../names.js";
import { dateParts, MONTHS_FULL, pageRange, isPageRange } from "../dates.js";
import { arxivId, doiUrl, editionLabel, isPreprint } from "./common.js";

/** APA 7th edition reference list entry. Titles are used as entered (APA expects sentence case). */
export function apaAuthors(names: Name[]): string {
  const f = names.map(familyInitials);
  if (f.length === 1) return f[0]!;
  if (f.length === 2) return `${f[0]}, & ${f[1]}`;
  if (f.length <= 20) return `${f.slice(0, -1).join(", ")}, & ${f[f.length - 1]}`;
  return `${f.slice(0, 19).join(", ")}, . . . ${f[f.length - 1]}`;
}

function apaDate(ref: Reference, suffix = "", withMonthDay = false): string {
  const d = dateParts(ref.issued);
  if (!d.year) return `(n.d.${suffix ? `-${suffix}` : ""})`;
  let s = `${d.year}${suffix}`;
  if (withMonthDay && d.month) s += `, ${MONTHS_FULL[d.month - 1]}${d.day ? ` ${d.day}` : ""}`;
  return `(${s})`;
}

function editorsInline(eds: Name[] | undefined): string | undefined {
  if (!eds?.length) return undefined;
  const list = eds.map(initialsFamily);
  const joined = list.length === 1 ? list[0]! : list.length === 2 ? `${list[0]} & ${list[1]}` : `${list.slice(0, -1).join(", ")}, & ${list[list.length - 1]}`;
  return `${joined} (${eds.length > 1 ? "Eds." : "Ed."})`;
}

export function apaReference(ref: Reference, yearSuffix = ""): Rich {
  const b = new RichBuilder();
  const authors = ref.author?.length ? ref.author : undefined;
  const web = ref.type === "webpage" || ref.type === "post-weblog";
  const titleItalic = !["article-journal", "article-magazine", "article-newspaper", "chapter", "paper-conference"].includes(ref.type) || isPreprint(ref);
  const container = ref["container-title"];

  // Author element. With no author, the title moves to the author position.
  if (authors) {
    b.add(apaAuthors(authors)).punct(".").add(" ");
    b.add(apaDate(ref, yearSuffix, web || ref.type === "article-newspaper" || ref.type === "article-magazine")).add(". ");
  }

  if (ref.title) {
    if (titleItalic) b.italic(ref.title);
    else b.add(ref.title);
  }
  // Bracketed/parenthetical descriptors directly after the title.
  const id = arxivId(ref);
  if (isPreprint(ref) && id) b.add(` (arXiv:${id})`);
  const ed = editionLabel(ref.edition);
  if (ed && titleItalic) b.add(` (${ed})`);
  if ((ref.type === "report" || ref.type === "standard") && ref.number) b.add(` (${ref.type === "report" ? "Report No. " : ""}${ref.number})`);
  if (ref.type === "thesis") {
    const kind = ref.genre ?? "Doctoral dissertation";
    b.add(` [${[kind, ref.publisher].filter(Boolean).join(", ")}]`);
  }
  if (ref.type === "software" && ref.version) b.add(` (Version ${ref.version})`);
  if (ref.type === "dataset") b.add(" [Data set]");
  if (ref.title) b.punct(".");

  if (!authors) {
    b.add(" ").add(apaDate(ref, yearSuffix, web)).add(".");
  }

  if (ref.type === "chapter" || (ref.type === "paper-conference" && ref.editor?.length)) {
    b.add(" In ");
    const eds = editorsInline(ref.editor);
    if (eds) b.add(`${eds}, `);
    b.italic(container);
    const pages = pageRange(ref.page);
    if (pages) b.add(` (${isPageRange(ref.page) ? "pp." : "p."} ${pages})`);
    b.add(".");
    if (ref.publisher) b.add(` ${ref.publisher}.`);
  } else if (["article-journal", "article-magazine", "article-newspaper", "paper-conference"].includes(ref.type) && container && !isPreprint(ref)) {
    b.add(" ").italic(container);
    if (ref.volume) b.add(", ").italic(String(ref.volume));
    if (ref.issue) b.add(`(${ref.issue})`);
    const pages = pageRange(ref.page);
    if (pages) b.add(`, ${pages}`);
    b.add(".");
  } else if (isPreprint(ref)) {
    b.add(" arXiv.");
  } else if (web) {
    const site = container ?? ref.publisher;
    // APA omits the site name when it duplicates the author.
    if (site && !(authors?.length === 1 && familyName(authors[0]!) === site)) b.add(` ${site}.`);
  } else if (ref.type !== "thesis" && ref.publisher) {
    const authorIsPublisher = authors?.length === 1 && familyName(authors[0]!) === ref.publisher;
    if (!authorIsPublisher) b.add(` ${ref.publisher}.`);
  }

  const doi = doiUrl(ref.DOI) ?? (isPreprint(ref) && id ? `https://doi.org/10.48550/arXiv.${id}` : undefined);
  if (doi) b.add(" ").link(doi, doi);
  else if (ref.URL) b.add(" ").link(ref.URL, ref.URL);
  return b.build();
}

export function apaCiteNames(names: Name[] | undefined, fallbackTitle?: string): string {
  if (!names?.length) return fallbackTitle ? `“${fallbackTitle}”` : "Anonymous";
  const fam = names.map(familyName);
  if (fam.length === 1) return fam[0]!;
  if (fam.length === 2) return `${fam[0]} & ${fam[1]}`;
  return `${fam[0]} et al.`;
}

export function apaCitation(ref: Reference, opts: CiteOptions = {}, yearSuffix = ""): string {
  const d = dateParts(ref.issued);
  const year = d.year ? `${d.year}${yearSuffix}` : `n.d.${yearSuffix ? `-${yearSuffix}` : ""}`;
  const names = apaCiteNames(ref.author, ref.title);
  const loc = opts.locator ? `, ${opts.locator}` : "";
  if (opts.narrative) return `${names.replace(" & ", " and ")} (${year}${loc})`;
  return `(${names}, ${year}${loc})`;
}
