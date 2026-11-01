import { createId, systemClock, type Clock, type Collection, type Entity, type Id } from "@aether/research-core";
import { anchor, describeRange, type PageSelector, type Selector, type TextPositionSelector, type TextQuoteSelector } from "./anchor.js";

export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "orange";
export const COLOR_MEANING: Record<HighlightColor, string> = {
  yellow: "Key point",
  green: "Definition / method",
  blue: "Result / data",
  pink: "Question / disagree",
  orange: "To cite",
};

export interface Annotation extends Entity {
  /** Page URL or `pdf:<fingerprint>` for PDFs. */
  source: string;
  sourceTitle?: string;
  selectors: Selector[];
  motivation: "highlighting" | "commenting" | "bookmarking";
  color: HighlightColor;
  comment?: string;
  tags: string[];
  /** Citation key in the reference library, so quotes cite correctly. */
  referenceId?: string;
  workspaceId?: Id;
}

export const quoteOf = (a: Annotation) => a.selectors.find((s): s is TextQuoteSelector => s.type === "TextQuoteSelector");
export const positionOf = (a: Annotation) => a.selectors.find((s): s is TextPositionSelector => s.type === "TextPositionSelector");
export const pageOf = (a: Annotation) => a.selectors.find((s): s is PageSelector => s.type === "PageSelector")?.page;

export interface NewHighlight {
  source: string;
  sourceTitle?: string;
  /** Full text of the page (or PDF page) the selection was made in. */
  text: string;
  start: number;
  end: number;
  page?: number;
  color?: HighlightColor;
  comment?: string;
  tags?: string[];
  referenceId?: string;
  workspaceId?: Id;
}

export class AnnotationStore {
  constructor(
    private readonly items: Collection<Annotation>,
    private readonly clock: Clock = systemClock,
  ) {}

  async highlight(h: NewHighlight): Promise<Annotation> {
    const now = this.clock.now().toISOString();
    const selectors: Selector[] = [...describeRange(h.text, h.start, h.end)];
    if (h.page) selectors.push({ type: "PageSelector", page: h.page });
    const a: Annotation = {
      id: createId("ann"),
      createdAt: now,
      updatedAt: now,
      source: h.source,
      selectors,
      motivation: h.comment ? "commenting" : "highlighting",
      color: h.color ?? "yellow",
      tags: h.tags ?? [],
      ...(h.sourceTitle ? { sourceTitle: h.sourceTitle } : {}),
      ...(h.comment ? { comment: h.comment } : {}),
      ...(h.referenceId ? { referenceId: h.referenceId } : {}),
      ...(h.workspaceId ? { workspaceId: h.workspaceId } : {}),
    };
    await this.items.put(a);
    return a;
  }

  async update(id: Id, patch: Partial<Pick<Annotation, "color" | "comment" | "tags" | "referenceId">>): Promise<Annotation> {
    const cur = await this.items.get(id);
    if (!cur) throw new Error(`Annotation ${id} not found`);
    const next: Annotation = { ...cur, ...patch, updatedAt: this.clock.now().toISOString() };
    if (patch.comment !== undefined) next.motivation = patch.comment ? "commenting" : "highlighting";
    await this.items.put(next);
    return next;
  }

  delete(id: Id) {
    return this.items.delete(id);
  }

  async forSource(source: string): Promise<Annotation[]> {
    const list = await this.items.list((a) => a.source === source);
    return list.sort((a, b) => (pageOf(a) ?? 0) - (pageOf(b) ?? 0) || (positionOf(a)?.start ?? 0) - (positionOf(b)?.start ?? 0));
  }

  async forWorkspace(workspaceId: Id): Promise<Annotation[]> {
    return this.items.list((a) => a.workspaceId === workspaceId);
  }

  /** Anchor every annotation on a source against its current text; orphans are returned separately. */
  async anchorAll(source: string, text: string, page?: number) {
    const anchored: Array<{ annotation: Annotation; start: number; end: number; method: string }> = [];
    const orphaned: Annotation[] = [];
    for (const a of await this.forSource(source)) {
      if (page !== undefined && pageOf(a) !== page) continue;
      const q = quoteOf(a);
      const r = q ? anchor(text, q, positionOf(a)) : null;
      if (r) anchored.push({ annotation: a, ...r });
      else orphaned.push(a);
    }
    return { anchored, orphaned };
  }
}

/** Export highlights as Markdown quotes with pandoc citations, ready to paste into a note or paper. */
export function annotationsToMarkdown(list: Annotation[], opts: { heading?: string } = {}): string {
  const out: string[] = [];
  if (opts.heading) out.push(`## ${opts.heading}`, "");
  for (const a of list) {
    const q = quoteOf(a)?.exact.replace(/\s+/g, " ").trim();
    if (!q) continue;
    const page = pageOf(a);
    const cite = a.referenceId ? ` [@${a.referenceId}${page ? `, p. ${page}` : ""}]` : page ? ` (p. ${page})` : "";
    out.push(`> ${q}${cite}`);
    if (a.comment) out.push("", a.comment);
    if (a.tags.length) out.push("", a.tags.map((t) => `#${t}`).join(" "));
    out.push("");
  }
  return out.join("\n").trimEnd() + "\n";
}

/** W3C Web Annotation JSON-LD, for interchange with Hypothesis and other tools. */
export function toW3C(a: Annotation): Record<string, unknown> {
  const selectors = a.selectors.map((s) => (s.type === "PageSelector" ? { type: "FragmentSelector", conformsTo: "http://tools.ietf.org/rfc/rfc3778", value: `page=${s.page}` } : s));
  return {
    "@context": "http://www.w3.org/ns/anno.jsonld",
    id: `urn:aether:annotation:${a.id}`,
    type: "Annotation",
    motivation: a.motivation,
    created: a.createdAt,
    modified: a.updatedAt,
    ...(a.comment || a.tags.length
      ? {
          body: [
            ...(a.comment ? [{ type: "TextualBody", value: a.comment, purpose: "commenting" }] : []),
            ...a.tags.map((t) => ({ type: "TextualBody", value: t, purpose: "tagging" })),
          ],
        }
      : {}),
    target: { source: a.source, selector: selectors.length === 1 ? selectors[0] : selectors },
  };
}
