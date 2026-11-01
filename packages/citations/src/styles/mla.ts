import type { Reference, Rich, CiteOptions } from "../types.js";
import { RichBuilder, quoted } from "../rich.js";
import { familyGiven, familyName, givenFamily } from "../names.js";
import { dateParts, MONTHS_MLA, pageRange, isPageRange } from "../dates.js";
import { doiUrl, editionLabel } from "./common.js";

function mlaDate(d: ReturnType<typeof dateParts>): string | undefined {
  if (!d.year) return undefined;
  return [d.day, d.month ? MONTHS_MLA[d.month - 1] : undefined, d.year].filter(Boolean).join(" ");
}

/** MLA 9th edition Works Cited entry. */
export function mlaReference(ref: Reference): Rich {
  const b = new RichBuilder();
  const a = ref.author ?? [];
  if (a.length === 1) b.add(familyGiven(a[0]!));
  else if (a.length === 2) b.add(`${familyGiven(a[0]!)}, and ${givenFamily(a[1]!)}`);
  else if (a.length > 2) b.add(`${familyGiven(a[0]!)}, et al`);
  if (a.length) b.punct(".").add(" ");

  const standalone = ["book", "report", "thesis", "software", "dataset", "standard", "motion_picture"].includes(ref.type) || (!ref["container-title"] && ref.type !== "webpage");
  if (ref.title) {
    if (standalone) b.italic(ref.title).punct(".");
    else b.add(quoted(ref.title, "."));
  }

  // Container elements separated by commas, ending with a period.
  const els: Array<{ t: string; italic?: boolean; href?: string }> = [];
  if (ref["container-title"] && !standalone) els.push({ t: ref["container-title"], italic: true });
  if (ref.editor?.length) els.push({ t: `edited by ${ref.editor.map(givenFamily).join(" and ")}` });
  const ed = editionLabel(ref.edition);
  if (ed) els.push({ t: ed });
  if (ref.volume) els.push({ t: `vol. ${ref.volume}` });
  if (ref.issue) els.push({ t: `no. ${ref.issue}` });
  const authorIsPublisher = a.length === 1 && familyName(a[0]!) === ref.publisher;
  if (ref.publisher && !authorIsPublisher && ref.publisher !== ref["container-title"]) els.push({ t: ref.publisher });
  const date = mlaDate(dateParts(ref.issued));
  if (date) els.push({ t: date });
  const p = pageRange(ref.page);
  if (p) els.push({ t: `${isPageRange(ref.page) ? "pp." : "p."} ${p}` });
  const loc = doiUrl(ref.DOI) ?? ref.URL?.replace(/^https?:\/\//, "");
  if (loc) els.push({ t: loc, href: doiUrl(ref.DOI) ?? ref.URL });

  if (els.length) {
    b.add(" ");
    els.forEach((e, i) => {
      if (i) b.add(", ");
      b.add(e.t, { italic: e.italic, href: e.href });
    });
    b.punct(".");
  }
  if (ref.type === "thesis") b.add(` ${ref.genre ?? "PhD dissertation"}.`);
  const acc = mlaDate(dateParts(ref.accessed));
  if (acc && !ref.DOI) b.add(` Accessed ${acc}.`);
  return b.build();
}

export function mlaCitation(ref: Reference, opts: CiteOptions = {}): string {
  const a = ref.author ?? [];
  const name =
    a.length === 0 ? `“${ref["title-short"] ?? ref.title ?? "Anonymous"}”` : a.length === 1 ? familyName(a[0]!) : a.length === 2 ? `${familyName(a[0]!)} and ${familyName(a[1]!)}` : `${familyName(a[0]!)} et al.`;
  const loc = opts.locator ? ` ${opts.locator.replace(/^pp?\.\s*/, "")}` : "";
  return opts.narrative ? `${name}${loc ? ` (${loc.trim()})` : ""}` : `(${name}${loc})`;
}
