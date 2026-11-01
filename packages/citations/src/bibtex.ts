import type { Name, Reference, ReferenceType } from "./types.js";
import { parseNameList, familyName } from "./names.js";
import { dateParts, makeDate, MONTHS_FULL } from "./dates.js";
import { decodeLatex, encodeLatex } from "./latex-chars.js";
import { arxivId, normalizeDoi } from "./styles/common.js";

export interface BibtexEntry {
  type: string;
  key: string;
  fields: Record<string, string>;
}

export interface BibtexParseResult {
  entries: BibtexEntry[];
  errors: Array<{ offset: number; message: string }>;
}

const MONTH_MACROS: Record<string, string> = {
  jan: "1", feb: "2", mar: "3", apr: "4", may: "5", jun: "6", jul: "7", aug: "8", sep: "9", oct: "10", nov: "11", dec: "12",
};

/**
 * Tolerant BibTeX parser: supports braces and quotes, nested braces, @string
 * macros, `#` concatenation, @comment/@preamble, and recovers from malformed
 * entries by skipping to the next `@`.
 */
export function parseBibtex(src: string): BibtexParseResult {
  const entries: BibtexEntry[] = [];
  const errors: BibtexParseResult["errors"] = [];
  const macros: Record<string, string> = { ...MONTH_MACROS };
  let i = 0;

  const ws = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const ident = () => {
    const m = /^[^\s,={}()"#%@]+/.exec(src.slice(i));
    if (!m) throw new Error("Expected identifier");
    i += m[0].length;
    return m[0];
  };
  const braced = (): string => {
    // assumes src[i] === '{'
    let depth = 0;
    const start = i + 1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          i++;
          return src.slice(start, i - 1);
        }
      }
    }
    throw new Error("Unterminated brace");
  };
  const quotedStr = (): string => {
    let depth = 0;
    const start = ++i;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === '"' && depth === 0) {
        i++;
        return src.slice(start, i - 1);
      }
    }
    throw new Error("Unterminated string");
  };
  const value = (): string => {
    const parts: string[] = [];
    for (;;) {
      ws();
      const c = src[i];
      if (c === "{") parts.push(braced());
      else if (c === '"') parts.push(quotedStr());
      else if (c !== undefined && /\d/.test(c)) parts.push(ident());
      else {
        const name = ident();
        parts.push(macros[name.toLowerCase()] ?? name);
      }
      ws();
      if (src[i] === "#") {
        i++;
        continue;
      }
      return parts.join("");
    }
  };

  while (i < src.length) {
    const at = src.indexOf("@", i);
    if (at < 0) break;
    i = at + 1;
    const entryStart = at;
    try {
      ws();
      const type = ident().toLowerCase();
      ws();
      const open = src[i];
      if (open !== "{" && open !== "(") throw new Error(`Expected "{" after @${type}`);
      const close = open === "{" ? "}" : ")";
      i++;
      if (type === "comment") {
        i = entryStart + 1;
        if (open === "{") {
          i = src.indexOf("{", entryStart);
          braced();
        }
        continue;
      }
      if (type === "preamble") {
        value();
        ws();
        i++;
        continue;
      }
      if (type === "string") {
        ws();
        const name = ident();
        ws();
        if (src[i++] !== "=") throw new Error("Expected = in @string");
        macros[name.toLowerCase()] = value();
        ws();
        i++;
        continue;
      }
      ws();
      const key = ident();
      ws();
      const fields: Record<string, string> = {};
      while (src[i] === ",") {
        i++;
        ws();
        if (src[i] === close) break;
        const name = ident().toLowerCase();
        ws();
        if (src[i++] !== "=") throw new Error(`Expected = after field "${name}"`);
        fields[name] = value();
        ws();
      }
      if (src[i] !== close) throw new Error(`Expected "${close}" to close entry ${key}`);
      i++;
      entries.push({ type, key, fields });
    } catch (e) {
      errors.push({ offset: entryStart, message: (e as Error).message });
      i = entryStart + 1;
    }
  }
  return { entries, errors };
}

const TYPE_FROM_BIB: Record<string, ReferenceType> = {
  article: "article-journal",
  inproceedings: "paper-conference",
  conference: "paper-conference",
  proceedings: "book",
  book: "book",
  inbook: "chapter",
  incollection: "chapter",
  phdthesis: "thesis",
  mastersthesis: "thesis",
  thesis: "thesis",
  techreport: "report",
  report: "report",
  manual: "report",
  online: "webpage",
  electronic: "webpage",
  www: "webpage",
  misc: "article",
  unpublished: "manuscript",
  software: "software",
  dataset: "dataset",
  patent: "patent",
  standard: "standard",
};

export function bibtexToReference(e: BibtexEntry): Reference {
  const f = Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, v])) as Record<string, string | undefined>;
  const dec = (v: string | undefined) => (v === undefined ? undefined : decodeLatex(v));
  const type = TYPE_FROM_BIB[e.type] ?? "article";
  const ref: Reference = { id: e.key, type };
  const set = <K extends keyof Reference>(k: K, v: Reference[K] | undefined) => {
    if (v !== undefined && v !== "") ref[k] = v;
  };

  set("title", dec(f.title));
  if (f.author) ref.author = parseNameList(f.author).map(decodeName);
  if (f.editor) ref.editor = parseNameList(f.editor).map(decodeName);
  set("container-title", dec(f.journal ?? f.journaltitle ?? f.booktitle));
  set("volume", f.volume);
  set("issue", f.number && type !== "report" && type !== "standard" && type !== "patent" ? f.number : f.issue);
  if (type === "report" || type === "standard" || type === "patent") set("number", f.number);
  set("page", f.pages?.replace(/\s*-{1,2}\s*/g, "–"));
  set("publisher", dec(f.publisher ?? f.school ?? f.institution ?? f.organization));
  set("publisher-place", dec(f.address ?? f.location));
  set("edition", f.edition);
  set("DOI", f.doi ? normalizeDoi(f.doi) ?? f.doi : undefined);
  set("URL", f.url);
  set("ISBN", f.isbn);
  set("ISSN", f.issn);
  set("abstract", dec(f.abstract));
  set("keyword", dec(f.keywords));
  set("note", dec(f.note));
  set("version", f.version);
  if (e.type === "mastersthesis") ref.genre = "Master's thesis";
  else if (e.type === "phdthesis") ref.genre = "Doctoral dissertation";
  else set("genre", dec(f.type));

  if (f.date) {
    const d = dateParts({ raw: f.date });
    set("issued", makeDate(d.year, d.month, d.day));
  } else if (f.year) {
    const month = f.month ? parseInt(MONTH_MACROS[f.month.toLowerCase().slice(0, 3)] ?? f.month, 10) : undefined;
    set("issued", makeDate(parseInt(f.year, 10), Number.isFinite(month) ? month : undefined));
  }
  if (f.urldate) {
    const d = dateParts({ raw: f.urldate });
    set("accessed", makeDate(d.year, d.month, d.day));
  }
  const eprint = f.eprint;
  if (eprint && (f.archiveprefix ?? f.eprinttype ?? "").toLowerCase() === "arxiv") {
    ref.archive = "arXiv";
    ref["archive_location"] = eprint;
  }
  return ref;
}

function decodeName(n: Name): Name {
  const out: Name = {};
  for (const [k, v] of Object.entries(n)) if (v) (out as Record<string, string>)[k] = decodeLatex(v);
  return out;
}

export function importBibtex(src: string): { references: Reference[]; errors: BibtexParseResult["errors"] } {
  const { entries, errors } = parseBibtex(src);
  return { references: entries.map(bibtexToReference), errors };
}

const BIB_FROM_TYPE: Partial<Record<ReferenceType, string>> = {
  "article-journal": "article",
  "article-magazine": "article",
  "article-newspaper": "article",
  "paper-conference": "inproceedings",
  book: "book",
  chapter: "incollection",
  report: "techreport",
  webpage: "online",
  "post-weblog": "online",
  software: "software",
  dataset: "dataset",
  manuscript: "unpublished",
  patent: "patent",
  standard: "standard",
};

function bibName(n: Name): string {
  if (n.literal) return `{${n.literal}}`;
  const fam = [n["non-dropping-particle"], n.family].filter(Boolean).join(" ");
  return [fam, n.suffix, n.given].filter(Boolean).join(", ");
}

/** Wrap words with internal capitals (acronyms, "MOSFET", "pH") in braces so BibTeX styles keep their case. */
function protectCase(title: string): string {
  return title.replace(/(^|[\s(\-/])([\p{L}\d]*\p{Lu}[\p{L}\d]*\p{Lu}[\p{L}\d]*|[\p{Ll}\d]+\p{Lu}[\p{L}\d]*)/gu, (_m, pre: string, w: string) => `${pre}{${w}}`);
}

export function referenceToBibtex(ref: Reference): string {
  let type = BIB_FROM_TYPE[ref.type] ?? "misc";
  if (ref.type === "thesis") type = /master/i.test(ref.genre ?? "") ? "mastersthesis" : "phdthesis";
  const fields: Array<[string, string | undefined]> = [];
  const add = (k: string, v: string | number | undefined) => fields.push([k, v === undefined || v === "" ? undefined : String(v)]);
  if (ref.author?.length) add("author", ref.author.map(bibName).join(" and "));
  if (ref.editor?.length) add("editor", ref.editor.map(bibName).join(" and "));
  if (ref.title) add("title", protectCase(encodeLatex(ref.title)));
  const container = ref["container-title"];
  if (container) add(type === "article" ? "journal" : "booktitle", encodeLatex(container));
  const d = dateParts(ref.issued);
  add("year", d.year);
  if (d.month) add("month", MONTHS_FULL[d.month - 1]!.slice(0, 3).toLowerCase());
  add("volume", ref.volume);
  add("number", ref.issue ?? ref.number);
  if (ref.page) add("pages", ref.page.replace(/–|-+/g, "--"));
  const pubField = type === "phdthesis" || type === "mastersthesis" ? "school" : type === "techreport" ? "institution" : "publisher";
  if (ref.publisher) add(pubField, encodeLatex(ref.publisher));
  if (ref["publisher-place"]) add("address", encodeLatex(ref["publisher-place"]));
  add("edition", ref.edition);
  add("doi", ref.DOI);
  add("url", ref.URL);
  add("isbn", ref.ISBN);
  add("issn", ref.ISSN);
  const id = arxivId(ref);
  if (id) {
    add("eprint", id);
    add("archiveprefix", "arXiv");
  }
  const acc = dateParts(ref.accessed);
  if (acc.year) add("urldate", [acc.year, acc.month, acc.day].filter(Boolean).map((n, i) => (i ? String(n).padStart(2, "0") : n)).join("-"));
  if (ref.note) add("note", encodeLatex(ref.note));
  // Numeric months / years are written as bare macros/numbers.
  const body = fields
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => (k === "month" ? `  ${k} = ${v}` : `  ${k} = {${v}}`))
    .join(",\n");
  return `@${type}{${ref.id},\n${body}\n}`;
}

export function exportBibtex(refs: Reference[]): string {
  return refs.map(referenceToBibtex).join("\n\n") + "\n";
}

/**
 * Generate a citation key in the common "authorYearWord" form (e.g. "vaswani2017attention"),
 * made unique against `taken` with a/b/c suffixes.
 */
export function generateKey(ref: Pick<Reference, "author" | "issued" | "title">, taken: Set<string> = new Set()): string {
  const first = ref.author?.[0];
  const fam = first ? familyName(first) : "anon";
  const author = fam.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z]/g, "").toLowerCase() || "anon";
  const year = dateParts(ref.issued).year ?? "nd";
  const stop = new Set(["a", "an", "the", "on", "of", "for", "and", "in", "to", "with", "towards", "toward", "via", "using"]);
  const word = (ref.title ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((w) => w && !stop.has(w)) ?? "";
  const base = `${author}${year}${word}`;
  let key = base;
  for (let n = 0; taken.has(key); n++) key = base + String.fromCharCode(97 + (n % 26)) + (n >= 26 ? Math.floor(n / 26) : "");
  return key;
}
