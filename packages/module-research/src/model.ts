import type { Entity, Id } from "@aether/research-core";
import type { Reference } from "@aether/citations";

/**
 * Research & Writing module data model.
 *
 * Every derived statement (an extracted finding, a matrix cell, a review
 * bullet, a gap hypothesis) carries a pointer back to the source it came from
 * and to how it was produced (typed by the user, suggested by a heuristic, or
 * suggested by an AI model). Nothing the module produces is stored as a bare,
 * unattributed claim.
 */

/** Where a piece of extracted or derived content came from. */
export type Origin = "manual" | "heuristic" | "ai";

/** Suggestions stay "suggested" until the user accepts, edits or rejects them. */
export type ReviewStatus = "suggested" | "accepted" | "rejected";

/** Pointer into a source: a page number, an annotation, or a character range of the text the user supplied. */
export interface Locator {
  page?: number;
  annotationId?: Id;
  /** Free label such as "Table 2" or "§4.1". */
  label?: string;
}

/** A literature-review project: a set of library sources, questions and comparison criteria. */
export interface LabProject extends Entity {
  title: string;
  description?: string;
  workspaceId?: Id;
  /** Library reference ids (citation keys) included in this project. */
  sourceIds: string[];
  /**
   * Snapshot of each source's metadata from the shared library, so the project
   * (matrix, outline, gaps) works offline and keeps working if a library item
   * is later edited. Refreshed whenever the UI syncs with the library.
   */
  sources: Record<string, Reference>;
  /** Columns of the comparison matrix. */
  criteria: Criterion[];
  /** Manual matrix cells: cells[sourceId][criterionId]. Override derived values. */
  cells: Record<string, Record<string, MatrixCellValue>>;
  /** Screening decisions for sources, PRISMA style. */
  screening: Record<string, ScreeningDecision>;
  /** Scope statement and inclusion/exclusion criteria used when screening. */
  scope?: { statement?: string; inclusion: string[]; exclusion: string[]; fromYear?: number; toYear?: number };
}

export interface ScreeningDecision {
  status: "include" | "exclude" | "maybe";
  reason?: string;
  /** Which inclusion/exclusion criteria the decision applied (by text). */
  criteria?: string[];
  at: string;
}

export type ReadingStatus = "queued" | "reading" | "read" | "skipped";
export const TAG_FACETS = ["topic", "methodology", "domain", "dataset", "application"] as const;
export type TagFacet = (typeof TAG_FACETS)[number];

/** Per-reference reading state and tags. Keyed by the library reference id. */
export interface ReadingItem extends Entity {
  /** Same as id: the library reference id. */
  refId: string;
  status: ReadingStatus;
  tags: Partial<Record<TagFacet, string[]>>;
  /** 0 = not rated, 1–3 = low to high relevance. */
  relevance: 0 | 1 | 2 | 3;
  note?: string;
  /** Snapshot so the queue reads offline. */
  title?: string;
  position: number;
}

export const EXTRACTION_FIELDS = ["objective", "methods", "datasets", "metrics", "findings", "limitations", "futureWork"] as const;
export type ExtractionField = (typeof EXTRACTION_FIELDS)[number];

export const FIELD_LABELS: Record<ExtractionField, string> = {
  objective: "Objective / question",
  methods: "Methods",
  datasets: "Datasets / materials",
  metrics: "Metrics / measures",
  findings: "Findings",
  limitations: "Limitations",
  futureWork: "Future work (stated by authors)",
};

export interface Criterion {
  id: Id;
  label: string;
  /** If set, cells are filled from accepted extraction items for this field. */
  field?: ExtractionField;
}

export interface MatrixCellValue {
  text: string;
  origin: Origin;
  at: string;
}

/** One extracted statement about a source. */
export interface ExtractionItem extends Entity {
  projectId: Id;
  sourceId: string;
  field: ExtractionField;
  /** The statement, in the user's words or as suggested. */
  text: string;
  /** Short canonical labels used for grouping and gap analysis, e.g. "CNN", "ImageNet". */
  labels: string[];
  /** Verbatim span from the source text supporting this item. Required for heuristic/AI suggestions. */
  quote?: string;
  locator?: Locator;
  origin: Origin;
  status: ReviewStatus;
  /** For AI suggestions: provider/model and the gateway audit id. */
  ai?: { provider: string; model: string; auditId?: string };
  /** Which text the suggestion was taken from. */
  basis?: "abstract" | "supplied-text" | "page" | "pdf";
}

export type QuestionStatus = "open" | "investigating" | "answered" | "parked";

export interface ResearchQuestion extends Entity {
  projectId: Id;
  text: string;
  parentId?: Id;
  status: QuestionStatus;
  notes?: string;
  order: number;
}

export type Stance = "supports" | "contradicts" | "mixed" | "context";

/** A source-backed piece of evidence attached to a research question. */
export interface Evidence extends Entity {
  projectId: Id;
  questionId: Id;
  sourceId: string;
  stance: Stance;
  /** What this source says, as summarised by the user. */
  claim: string;
  quote?: string;
  locator?: Locator;
  extractionId?: Id;
  origin: Origin;
}

export type GapKind = "uncovered-combination" | "unanswered-question" | "thin-evidence" | "contested" | "shared-limitation" | "stated-future-work" | "dated-evidence";

/** Stored user decision on a computed gap hypothesis (hypotheses themselves are recomputed). */
export interface GapDecision extends Entity {
  projectId: Id;
  /** Stable key of the hypothesis (kind + inputs). */
  key: string;
  status: "kept" | "dismissed";
  note?: string;
}

export type VerificationStatus =
  /** Identifier resolves and the record matches the registry. */
  | "verified"
  /** Identifier resolves but title/authors/year differ. */
  | "mismatch"
  /** The DOI or arXiv id does not resolve: possibly mistyped or fabricated. */
  | "not-found"
  /** No identifier; a likely match was found by search. User must confirm. */
  | "candidate"
  /** No identifier and no confident match. Not proof that the work does not exist. */
  | "unmatched"
  /** Network or service error; try again. */
  | "error"
  /** Online checks are off. */
  | "offline";

export interface FieldDiff {
  field: "title" | "author" | "issued" | "container-title" | "DOI" | "volume" | "page";
  ours: string;
  registry: string;
  severity: "error" | "warning";
}

export interface VerificationRecord extends Entity {
  /** Library reference id. */
  refId: string;
  status: VerificationStatus;
  checkedAt: string;
  /** Registry used: "crossref", "doi.org", "arxiv", "openalex". */
  registry?: string;
  diffs: FieldDiff[];
  /** For "candidate": the record we found, for the user to accept or ignore. */
  candidate?: Reference;
  /** Title similarity, 0–1, for candidate matches. */
  similarity?: number;
  /** Retraction or correction notices found in the registry. */
  notices: Array<{ kind: "retraction" | "correction" | "expression-of-concern" | "withdrawal" | "other"; label: string; doi?: string; source: string }>;
  message: string;
}

/** A single discovery result, normalised across services. */
export interface DiscoveryHit {
  /** Stable merge key: doi:..., arxiv:..., or t:<normalised title>:<year>. */
  key: string;
  reference: Reference;
  /** Services that returned this work, with their own ids/links. */
  found: Array<{ service: DiscoveryService; id?: string; url?: string }>;
  citedBy?: number;
  openAccessUrl?: string;
  isRetracted?: boolean;
  /** Already in the user's library (by DOI or key). */
  inLibrary?: string;
}

export type DiscoveryService = "crossref" | "openalex" | "arxiv" | "pubmed" | "semanticscholar";

export const SERVICE_INFO: Record<DiscoveryService, { label: string; host: string; sends: string; docs: string }> = {
  crossref: { label: "Crossref", host: "api.crossref.org", sends: "your search terms (and contact email if set)", docs: "https://www.crossref.org/documentation/retrieve-metadata/rest-api/" },
  openalex: { label: "OpenAlex", host: "api.openalex.org", sends: "your search terms (and contact email or API key if set)", docs: "https://docs.openalex.org/" },
  arxiv: { label: "arXiv", host: "export.arxiv.org", sends: "your search terms", docs: "https://info.arxiv.org/help/api/" },
  pubmed: { label: "PubMed", host: "eutils.ncbi.nlm.nih.gov", sends: "your search terms", docs: "https://www.ncbi.nlm.nih.gov/books/NBK25501/" },
  semanticscholar: { label: "Semantic Scholar", host: "api.semanticscholar.org", sends: "your search terms (and API key if set)", docs: "https://api.semanticscholar.org/api-docs/" },
};

/** A page saved for offline reading. The archive (MHTML) lives in the module's data folder; the text is indexed for search. */
export interface SavedPage extends Entity {
  url: string;
  title: string;
  /** Readable text captured at save time (capped). */
  text: string;
  workspaceId?: Id;
  /** Archive file name inside <dataDir>/pages, if the archive was written. */
  archive?: string;
  bytes?: number;
  dois: string[];
  /** Library reference id, if the user also cited it. */
  refId?: string;
  tags: string[];
}

/** A visited page in the opt-in research trail. */
export interface TrailEntry extends Entity {
  url: string;
  title: string;
  workspaceId?: Id;
  visits: number;
  lastVisit: string;
}

export interface LabSettings {
  /** Master switch for every network call the module makes. Off by default. */
  online: boolean;
  services: Record<DiscoveryService, boolean>;
  /** Contact email for Crossref/OpenAlex polite pools. Only sent if set. */
  mailto?: string;
  /** Sources older than this are flagged as dated evidence (informational). */
  datedAfterYears: number;
  /** Research trail: record pages visited in non-private windows. Off by default. */
  trail: boolean;
  /** Trail entries older than this many days are deleted. */
  trailDays: number;
}

export const DEFAULT_LAB_SETTINGS: LabSettings = {
  online: false,
  services: { crossref: true, openalex: true, arxiv: true, pubmed: true, semanticscholar: false },
  datedAfterYears: 10,
  trail: false,
  trailDays: 30,
};

/** Metadata-only record of each request the module sent. Never stores responses. */
export interface NetworkLogEntry {
  at: string;
  service: string;
  host: string;
  purpose: string;
  /** What was sent, in words (e.g. the query text or the DOI). */
  sent: string;
  status: number | "error" | "blocked";
  ms: number;
}
