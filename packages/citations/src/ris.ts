import type { Reference, ReferenceType } from "./types.js";
import { parseName, familyName } from "./names.js";
import { dateParts, makeDate } from "./dates.js";

const RIS_TYPE: Partial<Record<ReferenceType, string>> = {
  "article-journal": "JOUR", "article-magazine": "MGZN", "article-newspaper": "NEWS", "paper-conference": "CPAPER",
  book: "BOOK", chapter: "CHAP", report: "RPRT", thesis: "THES", webpage: "ELEC", dataset: "DATA",
  software: "COMP", patent: "PAT", standard: "STAND", manuscript: "UNPB", article: "GEN",
};
const TYPE_FROM_RIS = Object.fromEntries(Object.entries(RIS_TYPE).map(([k, v]) => [v, k])) as Record<string, ReferenceType>;
TYPE_FROM_RIS["CONF"] = "paper-conference";
TYPE_FROM_RIS["EJOUR"] = "article-journal";

/** Export references as RIS (EndNote, Mendeley, Zotero import format). */
export function exportRis(refs: Reference[]): string {
  return refs
    .map((r) => {
      const lines: string[] = [`TY  - ${RIS_TYPE[r.type] ?? "GEN"}`, `ID  - ${r.id}`];
      const add = (tag: string, v: string | number | undefined) => {
        if (v !== undefined && v !== "") lines.push(`${tag}  - ${v}`);
      };
      for (const a of r.author ?? []) add("AU", a.literal ?? [familyName(a), a.given, a.suffix].filter(Boolean).join(", "));
      for (const e of r.editor ?? []) add("ED", e.literal ?? [familyName(e), e.given].filter(Boolean).join(", "));
      add("TI", r.title);
      add("T2", r["container-title"]);
      const d = dateParts(r.issued);
      if (d.year) add("PY", d.year);
      if (d.year) add("DA", [d.year, d.month && String(d.month).padStart(2, "0"), d.day && String(d.day).padStart(2, "0")].filter(Boolean).join("/"));
      add("VL", r.volume);
      add("IS", r.issue);
      const [sp, ep] = (r.page ?? "").split(/–|-+/);
      add("SP", sp);
      add("EP", ep);
      add("PB", r.publisher);
      add("CY", r["publisher-place"]);
      add("DO", r.DOI);
      add("UR", r.URL);
      add("SN", r.ISBN ?? r.ISSN);
      add("AB", r.abstract);
      add("N1", r.note);
      lines.push("ER  - ");
      return lines.join("\r\n");
    })
    .join("\r\n\r\n");
}

export function importRis(src: string): Reference[] {
  const refs: Reference[] = [];
  let cur: Record<string, string[]> | null = null;
  for (const raw of src.split(/\r?\n/)) {
    const m = raw.match(/^([A-Z][A-Z0-9])  - ?(.*)$/);
    if (!m) continue;
    const [, tag, val] = m as unknown as [string, string, string];
    if (tag === "TY") cur = { TY: [val.trim()] };
    else if (tag === "ER") {
      if (cur) refs.push(risToRef(cur, refs.length));
      cur = null;
    } else if (cur) (cur[tag] ??= []).push(val.trim());
  }
  return refs;
}

function risToRef(f: Record<string, string[]>, index: number): Reference {
  const one = (...tags: string[]) => tags.map((t) => f[t]?.[0]).find(Boolean);
  const ref: Reference = { id: one("ID") ?? `ris${index + 1}`, type: TYPE_FROM_RIS[one("TY") ?? ""] ?? "article" };
  const authors = [...(f.AU ?? []), ...(f.A1 ?? [])];
  if (authors.length) ref.author = authors.map(parseName);
  if (f.ED?.length) ref.editor = f.ED.map(parseName);
  const title = one("TI", "T1");
  if (title) ref.title = title;
  const container = one("T2", "JO", "JF", "BT");
  if (container) ref["container-title"] = container;
  const date = one("DA", "PY", "Y1");
  if (date) {
    const [y, mo, d] = date.split("/").map((x) => parseInt(x, 10));
    const issued = makeDate(y, mo, d);
    if (issued) ref.issued = issued;
  }
  const map: Array<[keyof Reference, string[]]> = [
    ["volume", ["VL"]], ["issue", ["IS"]], ["publisher", ["PB"]], ["publisher-place", ["CY"]],
    ["DOI", ["DO"]], ["URL", ["UR"]], ["abstract", ["AB"]], ["note", ["N1"]],
  ];
  for (const [k, tags] of map) {
    const v = one(...tags);
    if (v) (ref as unknown as Record<string, string>)[k] = v;
  }
  const sp = one("SP");
  const ep = one("EP");
  if (sp) ref.page = ep ? `${sp}–${ep}` : sp;
  const sn = one("SN");
  if (sn) {
    if (/^(97[89])?\d{9}[\dX]$/i.test(sn.replace(/-/g, ""))) ref.ISBN = sn;
    else ref.ISSN = sn;
  }
  return ref;
}
