import type { Rich, Segment } from "./types.js";

/** Small builder that keeps punctuation tidy while assembling styled segments. */
export class RichBuilder {
  readonly parts: Segment[] = [];

  add(text: string | undefined | null, opts: Omit<Segment, "text"> = {}): this {
    if (text === undefined || text === null || text === "") return this;
    this.parts.push({ text, ...opts });
    return this;
  }

  italic(text: string | undefined): this {
    return this.add(text, { italic: true });
  }

  link(text: string, href: string): this {
    return this.add(text, { href });
  }

  /** Last visible character, used to avoid doubled punctuation like "?." */
  lastChar(): string {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const t = this.parts[i]!.text;
      if (t.length) return t[t.length - 1]!;
    }
    return "";
  }

  /** Append punctuation unless the text already ends with terminal punctuation. */
  punct(p: string): this {
    const last = this.lastChar();
    if (p === "." && /[.?!]/.test(last)) return this;
    if (p === "," && /[?!]/.test(last)) return this;
    return this.add(p);
  }

  build(): Rich {
    // Merge adjacent segments with identical styling.
    const out: Segment[] = [];
    for (const s of this.parts) {
      const prev = out[out.length - 1];
      if (prev && !!prev.italic === !!s.italic && prev.href === s.href) prev.text += s.text;
      else out.push({ ...s });
    }
    return out;
  }
}

/** Ends a title with punctuation inside quotes the way US styles do ("Title," / "Title."). */
export function quoted(title: string, trailing: "," | "." | ""): string {
  if (/[?!]$/.test(title)) return `“${title}”`;
  return `“${title}${trailing}”`;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const toPlain = (r: Rich): string => r.map((s) => s.text).join("");

export const toHtml = (r: Rich): string =>
  r
    .map((s) => {
      let t = escapeHtml(s.text);
      if (s.href && /^https?:\/\//i.test(s.href)) t = `<a href="${escapeHtml(s.href)}">${t}</a>`;
      if (s.italic) t = `<i>${t}</i>`;
      return t;
    })
    .join("");

export const toMarkdown = (r: Rich): string =>
  r
    .map((s) => {
      let t = s.text.replace(/([*_`[\]\\])/g, "\\$1");
      if (s.href) t = `<${s.href}>`;
      if (s.italic && t.trim()) {
        const lead = t.match(/^\s*/)![0];
        const tail = t.match(/\s*$/)![0];
        t = `${lead}*${t.trim()}*${tail}`;
      }
      return t;
    })
    .join("");

export function escapeLatex(s: string): string {
  return s
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/–/g, "--")
    .replace(/—/g, "---")
    .replace(/“/g, "``")
    .replace(/”/g, "''");
}

export const toLatex = (r: Rich): string =>
  r
    .map((s) => {
      if (s.href) return `\\url{${s.href.replace(/([%#])/g, "\\$1")}}`;
      const t = escapeLatex(s.text);
      return s.italic ? `\\textit{${t}}` : t;
    })
    .join("");
