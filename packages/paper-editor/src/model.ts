import type { Entity, Id } from "@aether/research-core";
import type { StyleId } from "@aether/citations";

export interface Section {
  id: Id;
  heading: string;
  /** 1 = section, 2 = subsection. */
  level: 1 | 2 | 3;
  /** Markdown with [@key] citations and $LaTeX$. */
  body: string;
  /** Writing guidance from the template, shown as placeholder text. */
  hint?: string;
  /** Sections like Abstract are exported specially and not numbered. */
  kind?: "abstract" | "keywords" | "acknowledgements" | "appendix" | "body";
  targetWords?: [number, number];
  /** Whether claims here normally need citations (Introduction, Related Work). */
  expectsCitations?: boolean;
}

export interface PaperAuthor {
  name: string;
  affiliation?: string;
  email?: string;
}

/**
 * A record of AI help on the paper. AETHER keeps this so writers can
 * disclose AI use accurately (many venues require it); it is never hidden.
 */
export interface AiContribution {
  id: Id;
  at: string;
  sectionId: Id;
  action: string;
  provider: string;
  model: string;
  /** Links to the gateway's audit entry. */
  auditId?: string;
  accepted: boolean;
  charsBefore: number;
  charsAfter: number;
}

export interface Snapshot {
  at: string;
  label?: string;
  sections: Section[];
  title: string;
}

export interface Paper extends Entity {
  title: string;
  templateId: string;
  style: StyleId;
  authors: PaperAuthor[];
  sections: Section[];
  /** Reference ids from the library that belong to this paper (cited or not). */
  referenceIds: string[];
  workspaceId?: Id;
  aiLog: AiContribution[];
  /** Manual version history (bounded). */
  snapshots: Snapshot[];
}
