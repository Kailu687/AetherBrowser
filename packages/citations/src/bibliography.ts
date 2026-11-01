import type { CiteOptions, Reference, Rich, StyleId } from "./types.js";
import { apaCitation, apaReference } from "./styles/apa.js";
import { ieeeCitation, ieeeReference } from "./styles/ieee.js";
import { mlaCitation, mlaReference } from "./styles/mla.js";
import { chicagoCitation, chicagoReference } from "./styles/chicago.js";
import { familyName, sortKey } from "./names.js";
import { dateParts } from "./dates.js";
import { toHtml, toLatex, toMarkdown, toPlain } from "./rich.js";

export const STYLES: Record<StyleId, { label: string; numeric: boolean }> = {
  apa: { label: "APA 7th", numeric: false },
  ieee: { label: "IEEE", numeric: true },
  mla: { label: "MLA 9th", numeric: false },
  chicago: { label: "Chicago 17th (author-date)", numeric: false },
};

export interface BibliographyEntry {
  id: string;
  /** "[3]" for IEEE; empty for author-date styles. */
  label: string;
  rich: Rich;
  text: string;
  html: string;
  markdown: string;
  latex: string;
}

/** Format a single reference in isolation (no numbering or year disambiguation). */
export function formatReference(ref: Reference, style: StyleId): Rich {
  switch (style) {
    case "apa":
      return apaReference(ref);
    case "ieee":
      return ieeeReference(ref);
    case "mla":
      return mlaReference(ref);
    case "chicago":
      return chicagoReference(ref);
  }
}

/**
 * A document's bibliography: tracks citation order (for numeric styles),
 * disambiguates same-author same-year works (2020a, 2020b) for author-date
 * styles, and renders in-text citations and the reference list.
 */
export class Bibliography {
  private readonly order: string[] = [];
  private readonly refs = new Map<string, Reference>();

  constructor(
    readonly style: StyleId,
    references: Iterable<Reference> = [],
  ) {
    for (const r of references) this.refs.set(r.id, r);
  }

  add(ref: Reference): void {
    this.refs.set(ref.id, ref);
  }

  has(id: string): boolean {
    return this.refs.has(id);
  }

  /** Returns the in-text citation for one or more keys and records citation order. Unknown keys render as "[?key]". */
  cite(ids: string | string[], opts: CiteOptions = {}): string {
    const list = Array.isArray(ids) ? ids : [ids];
    const known = list.filter((id) => this.refs.has(id));
    const missing = list.filter((id) => !this.refs.has(id));
    for (const id of known) if (!this.order.includes(id)) this.order.push(id);
    const missingText = missing.map((m) => `[?${m}]`).join(" ");
    if (!known.length) return missingText;

    let out: string;
    if (this.style === "ieee") {
      out = ieeeCitation(known.map((id) => this.order.indexOf(id) + 1));
      if (opts.locator) out = `${out.slice(0, -1)}, ${opts.locator}]`;
    } else if (known.length === 1 || opts.narrative) {
      out = known.map((id) => this.citeOne(id, opts)).join("; ");
    } else {
      // Combine parenthetical citations: (Smith, 2020; Jones, 2021)
      const inner = known.map((id, i) => this.citeOne(id, i === known.length - 1 ? opts : {}).replace(/^\(|\)$/g, ""));
      out = `(${inner.join("; ")})`;
    }
    return missing.length ? `${out} ${missingText}` : out;
  }

  private citeOne(id: string, opts: CiteOptions): string {
    const ref = this.refs.get(id)!;
    const suffix = this.yearSuffixes().get(id) ?? "";
    if (this.style === "apa") return apaCitation(ref, opts, suffix);
    if (this.style === "chicago") return chicagoCitation(ref, opts, suffix);
    return mlaCitation(ref, opts);
  }

  /** a/b/c suffixes for works sharing first-author family names and year. */
  private yearSuffixes(): Map<string, string> {
    const groups = new Map<string, Reference[]>();
    for (const r of this.refs.values()) {
      const names = (r.author ?? []).map(familyName).join("|").toLowerCase();
      const key = `${names}#${dateParts(r.issued).year ?? "nd"}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const out = new Map<string, string>();
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      g.sort((a, b) => (a.title ?? "").localeCompare(b.title ?? ""));
      g.forEach((r, i) => out.set(r.id, String.fromCharCode(97 + i)));
    }
    return out;
  }

  /** Reference ids in output order. */
  entryIds(includeUncited = false): string[] {
    if (STYLES[this.style].numeric) {
      const extra = includeUncited ? [...this.refs.keys()].filter((id) => !this.order.includes(id)) : [];
      return [...this.order, ...extra];
    }
    const ids = includeUncited ? [...this.refs.keys()] : [...this.order];
    return ids.sort((a, b) => {
      const ra = this.refs.get(a)!;
      const rb = this.refs.get(b)!;
      const ka = ra.author?.length ? (ra.author ?? []).map(sortKey).join(" ") : (ra.title ?? "").toLowerCase();
      const kb = rb.author?.length ? (rb.author ?? []).map(sortKey).join(" ") : (rb.title ?? "").toLowerCase();
      return ka.localeCompare(kb) || (dateParts(ra.issued).year ?? 0) - (dateParts(rb.issued).year ?? 0) || (ra.title ?? "").localeCompare(rb.title ?? "");
    });
  }

  entries(includeUncited = false): BibliographyEntry[] {
    const suffixes = this.yearSuffixes();
    return this.entryIds(includeUncited).map((id, i) => {
      const ref = this.refs.get(id)!;
      const sfx = suffixes.get(id) ?? "";
      const rich =
        this.style === "apa" ? apaReference(ref, sfx) : this.style === "chicago" ? chicagoReference(ref, sfx) : formatReference(ref, this.style);
      return {
        id,
        label: STYLES[this.style].numeric ? `[${i + 1}]` : "",
        rich,
        text: toPlain(rich),
        html: toHtml(rich),
        markdown: toMarkdown(rich),
        latex: toLatex(rich),
      };
    });
  }

  /** Cited keys that are not in the library: surfaced so writers can fix them before submission. */
  unresolved(citedKeys: string[]): string[] {
    return [...new Set(citedKeys.filter((k) => !this.refs.has(k)))];
  }
}
