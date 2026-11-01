/**
 * Bibliographic records use a subset of CSL-JSON (Citation Style Language),
 * so data round-trips with Zotero, citeproc-js and pandoc without mapping.
 * https://citeproc-js.readthedocs.io/en/latest/csl-json/markup.html
 */

export type ReferenceType =
  | "article-journal"
  | "article-magazine"
  | "article-newspaper"
  | "paper-conference"
  | "book"
  | "chapter"
  | "report"
  | "thesis"
  | "webpage"
  | "post-weblog"
  | "dataset"
  | "software"
  | "standard"
  | "patent"
  | "manuscript"
  | "speech"
  | "motion_picture"
  | "article";

export interface Name {
  family?: string;
  given?: string;
  /** "van", "de" — kept with the family name when sorting (CSL non-dropping particle). */
  "non-dropping-particle"?: string;
  "dropping-particle"?: string;
  suffix?: string;
  /** Organisations or names that must not be split, e.g. "IEEE". */
  literal?: string;
}

export interface CslDate {
  /** [[year, month?, day?]] */
  "date-parts"?: Array<Array<number | string>>;
  literal?: string;
  raw?: string;
}

export interface Reference {
  /** Citation key, unique within a library. */
  id: string;
  type: ReferenceType;
  title?: string;
  "title-short"?: string;
  author?: Name[];
  editor?: Name[];
  issued?: CslDate;
  accessed?: CslDate;
  "container-title"?: string;
  "container-title-short"?: string;
  "collection-title"?: string;
  "event-title"?: string;
  "event-place"?: string;
  volume?: string | number;
  issue?: string | number;
  page?: string;
  "number-of-pages"?: string | number;
  number?: string | number;
  edition?: string | number;
  publisher?: string;
  "publisher-place"?: string;
  /** Thesis/report kind, e.g. "Doctoral dissertation", "Technical report". */
  genre?: string;
  /** Archive or repository, e.g. "arXiv". */
  archive?: string;
  /** arXiv identifier or similar archive id. */
  "archive_location"?: string;
  medium?: string;
  version?: string;
  DOI?: string;
  URL?: string;
  ISBN?: string;
  ISSN?: string;
  PMID?: string;
  abstract?: string;
  keyword?: string;
  language?: string;
  note?: string;
}

export type StyleId = "apa" | "ieee" | "mla" | "chicago";

export interface Segment {
  text: string;
  italic?: boolean;
  /** Link target for URLs/DOIs. */
  href?: string;
}

/** A formatted entry as styled segments; render with `toPlain`, `toHtml`, `toMarkdown` or `toLatex`. */
export type Rich = Segment[];

export interface CiteOptions {
  /** Page or locator, e.g. "p. 12" — appended by the style. */
  locator?: string;
  /** Narrative form: "Smith (2020)" rather than "(Smith, 2020)". APA/Chicago only. */
  narrative?: boolean;
}
