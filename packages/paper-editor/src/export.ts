import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { Bibliography, escapeLatex, exportBibtex, type Reference } from "@aether/citations";
import { renderMarkdown, type KatexLike } from "@aether/notebook";
import type { Paper } from "./model.js";
import { getTemplate } from "./templates.js";

const CITE_RE = /\[(-?@[^\]\n]+)\]/g;
const citeKeys = (inner: string) =>
  inner
    .split(";")
    .map((p) => p.trim().match(/^-?@([\w:.#$%&\-+?<>~/]+)(?:\s*,\s*(.+))?$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => ({ key: m[1]!, locator: m[2]?.trim() }));

function libraryFor(paper: Paper, library: Map<string, Reference>): Bibliography {
  const bib = new Bibliography(paper.style);
  for (const id of new Set([...paper.referenceIds, ...library.keys()])) {
    const r = library.get(id);
    if (r) bib.add(r);
  }
  return bib;
}

/** Replace [@key] citations with formatted in-text citations (in document order, so IEEE numbering is correct). */
function resolveCitations(paper: Paper, library: Map<string, Reference>) {
  const bib = libraryFor(paper, library);
  const sections = paper.sections.map((s) => ({
    ...s,
    rendered: s.body.replace(CITE_RE, (m, inner: string) => {
      const items = citeKeys(inner);
      if (!items.length) return m;
      const loc = items.length === 1 ? items[0]!.locator : undefined;
      return bib.cite(items.map((i) => i.key), loc ? { locator: loc } : {});
    }),
  }));
  return { bib, sections };
}

/** Markdown with citations rendered in the paper's style and a reference list appended. */
export function exportMarkdown(paper: Paper, library: Map<string, Reference>): string {
  const { bib, sections } = resolveCitations(paper, library);
  const out: string[] = [`# ${paper.title}`, ""];
  if (paper.authors.length) out.push(paper.authors.map((a) => [a.name, a.affiliation].filter(Boolean).join(", ")).join("; "), "");
  for (const s of sections) {
    if (!s.rendered.trim() && s.kind !== "abstract") continue;
    out.push(`${"#".repeat(s.level + 1)} ${s.heading}`, "", s.rendered.trim(), "");
  }
  const entries = bib.entries();
  if (entries.length) {
    out.push("## References", "");
    for (const e of entries) out.push(`${e.label ? `${e.label} ` : "- "}${e.markdown}`, "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Pandoc-ready Markdown: keeps [@key] citations and writes YAML for `pandoc --citeproc`. */
export function exportPandoc(paper: Paper): string {
  const yaml = ["---", `title: ${JSON.stringify(paper.title)}`];
  if (paper.authors.length) yaml.push("author:", ...paper.authors.map((a) => `  - ${JSON.stringify(a.name)}`));
  yaml.push("bibliography: references.bib", `csl: ${paper.style === "ieee" ? "ieee.csl" : paper.style === "mla" ? "modern-language-association.csl" : paper.style === "chicago" ? "chicago-author-date.csl" : "apa.csl"}`, "---", "");
  const body = paper.sections.filter((s) => s.body.trim()).map((s) => `${"#".repeat(s.level)} ${s.heading}\n\n${s.body.trim()}\n`);
  return `${yaml.join("\n")}\n${body.join("\n")}`;
}

/** Convert one section's Markdown to LaTeX, mapping [@a; @b] to \cite{a,b}. */
export function markdownToLatex(md: string): string {
  // Protect math from Markdown emphasis/escaping, then restore it verbatim.
  const math: string[] = [];
  const hold = (tex: string) => `\u0001${math.push(tex) - 1}\u0001`;
  const prepared = md
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => `\n\n${hold(`\\[${tex}\\]`)}\n\n`)
    .replace(/(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_m, tex: string) => hold(`$${tex}$`));
  const tokens = new MarkdownIt({ html: false }).parse(prepared, {});
  return blockTokens(tokens)
    .replace(/\u0001(\d+)\u0001/g, (_m, i: string) => math[+i]!)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inline(tokens: Token[] = []): string {
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "text":
        out += textWithMathAndCites(t.content);
        break;
      case "code_inline":
        out += `\\texttt{${escapeLatex(t.content)}}`;
        break;
      case "softbreak":
        out += "\n";
        break;
      case "hardbreak":
        out += "\\\\\n";
        break;
      case "em_open":
        out += "\\emph{";
        break;
      case "strong_open":
        out += "\\textbf{";
        break;
      case "em_close":
      case "strong_close":
        out += "}";
        break;
      case "link_open":
        out += `\\href{${(t.attrGet("href") ?? "").replace(/([%#\\{}])/g, "\\$1")}}{`;
        break;
      case "link_close":
        out += "}";
        break;
      case "image":
        out += `\\includegraphics[width=\\linewidth]{${t.attrGet("src") ?? ""}}`;
        break;
      default:
        if (t.children) out += inline(t.children);
    }
  }
  return out;
}

/** Text outside $...$ is escaped; math passes through; [@key] becomes \cite. */
function textWithMathAndCites(s: string): string {
  const parts = s.split(/(\u0001\d+\u0001|\[-?@[^\]\n]+\])/g);
  return parts
    .map((p) => {
      if (/^\u0001\d+\u0001$/.test(p)) return p;
      const c = p.match(/^\[(-?@[^\]\n]+)\]$/);
      if (c) {
        const items = citeKeys(c[1]!);
        if (items.length) {
          const loc = items.length === 1 && items[0]!.locator ? `[${escapeLatex(items[0]!.locator)}]` : "";
          return `\\cite${loc}{${items.map((i) => i.key).join(",")}}`;
        }
      }
      return escapeLatex(p).replace(/"([^"]*)"/g, "``$1''");
    })
    .join("");
}

function blockTokens(tokens: Token[]): string {
  let out = "";
  const listStack: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t.type) {
      case "heading_open": {
        const lvl = Number(t.tag.slice(1));
        const cmd = lvl <= 1 ? "subsection" : lvl === 2 ? "subsubsection" : "paragraph";
        out += `\\${cmd}{${inline(tokens[i + 1]!.children ?? [])}}\n\n`;
        i += 2;
        break;
      }
      case "paragraph_open":
        if (listStack.length) break;
        break;
      case "paragraph_close":
        out += listStack.length ? "\n" : "\n\n";
        break;
      case "inline":
        out += inline(t.children ?? []);
        break;
      case "bullet_list_open":
        listStack.push("itemize");
        out += "\\begin{itemize}\n";
        break;
      case "ordered_list_open":
        listStack.push("enumerate");
        out += "\\begin{enumerate}\n";
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        out += `\\end{${listStack.pop()}}\n\n`;
        break;
      case "list_item_open":
        out += "  \\item ";
        break;
      case "fence":
      case "code_block":
        out += `\\begin{verbatim}\n${t.content}\\end{verbatim}\n\n`;
        break;
      case "blockquote_open":
        out += "\\begin{quote}\n";
        break;
      case "blockquote_close":
        out += "\\end{quote}\n\n";
        break;
      case "hr":
        out += "\\bigskip\\hrule\\bigskip\n\n";
        break;
      case "table_open":
        out += tableToLatex(tokens, i);
        while (tokens[i]!.type !== "table_close") i++;
        break;
      default:
        break;
    }
  }
  return out;
}

function tableToLatex(tokens: Token[], start: number): string {
  const rows: string[][] = [];
  let row: string[] | null = null;
  for (let i = start; tokens[i]!.type !== "table_close"; i++) {
    const t = tokens[i]!;
    if (t.type === "tr_open") row = [];
    else if (t.type === "tr_close" && row) rows.push(row);
    else if (t.type === "inline" && row) row.push(inline(t.children ?? []));
  }
  if (!rows.length) return "";
  const cols = rows[0]!.length;
  const body = rows.map((r, i) => `${r.join(" & ")} \\\\${i === 0 ? " \\hline" : ""}`).join("\n");
  return `\\begin{table}[h]\n\\centering\n\\begin{tabular}{${"l".repeat(cols)}}\n\\hline\n${body}\n\\hline\n\\end{tabular}\n\\end{table}\n\n`;
}

export interface LatexExport {
  /** main.tex */
  tex: string;
  /** references.bib */
  bib: string;
}

/** LaTeX project (IEEEtran for IEEE templates) plus a BibTeX file of every cited reference. */
export function exportLatex(paper: Paper, library: Map<string, Reference>): LatexExport {
  const template = getTemplate(paper.templateId);
  const cls = template?.latexClass ?? "article";
  const ieee = cls === "IEEEtran";
  const cited = new Set<string>();
  for (const s of paper.sections) for (const m of s.body.matchAll(CITE_RE)) citeKeys(m[1]!).forEach((c) => cited.add(c.key));
  const refs = [...new Set([...cited, ...paper.referenceIds])].map((k) => library.get(k)).filter((r): r is Reference => !!r);

  const lines: string[] = [
    ieee ? "\\documentclass[conference]{IEEEtran}" : `\\documentclass[11pt]{${cls}}`,
    "\\usepackage[utf8]{inputenc}",
    "\\usepackage[T1]{fontenc}",
    "\\usepackage{amsmath,amssymb}",
    "\\usepackage{graphicx}",
    ieee ? "\\usepackage{cite}" : "\\usepackage[numbers]{natbib}",
    "\\usepackage{hyperref}",
    "",
    `\\title{${escapeLatex(paper.title)}}`,
  ];
  if (ieee) {
    lines.push(
      `\\author{${paper.authors.map((a) => `\\IEEEauthorblockN{${escapeLatex(a.name)}}${a.affiliation || a.email ? `\n\\IEEEauthorblockA{${[a.affiliation, a.email].filter(Boolean).map((x) => escapeLatex(x!)).join(" \\\\ ")}}` : ""}`).join("\n\\and\n") || "Author"}}`,
    );
  } else {
    lines.push(`\\author{${paper.authors.map((a) => escapeLatex(a.name)).join(" \\and ") || "Author"}}`, "\\date{\\today}");
  }
  lines.push("", "\\begin{document}", "\\maketitle", "");
  const sectionCmd = cls === "report" ? ["chapter", "section", "subsection"] : ["section", "subsection", "subsubsection"];
  for (const s of paper.sections) {
    const body = markdownToLatex(s.body);
    if (s.kind === "abstract") {
      if (body) lines.push("\\begin{abstract}", body, "\\end{abstract}", "");
    } else if (s.kind === "keywords") {
      if (body) lines.push(ieee ? `\\begin{IEEEkeywords}\n${body}\n\\end{IEEEkeywords}` : `\\noindent\\textbf{Keywords:} ${body}`, "");
    } else if (s.kind === "acknowledgements") {
      if (body) lines.push(ieee ? "\\section*{Acknowledgment}" : "\\section*{Acknowledgements}", body, "");
    } else {
      lines.push(`\\${sectionCmd[s.level - 1] ?? "paragraph"}{${escapeLatex(s.heading)}}`, body, "");
    }
  }
  if (refs.length) {
    lines.push(ieee ? "\\bibliographystyle{IEEEtran}" : `\\bibliographystyle{${paper.style === "ieee" ? "ieeetr" : "plainnat"}}`, "\\bibliography{references}");
  }
  lines.push("\\end{document}", "");
  return { tex: lines.join("\n"), bib: refs.length ? exportBibtex(refs) : "" };
}

/** Standalone HTML for print/PDF via the browser's print dialog. */
export function exportHtml(paper: Paper, library: Map<string, Reference>, opts: { katex?: KatexLike; katexCss?: string } = {}): string {
  const { bib, sections } = resolveCitations(paper, library);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = sections
    .filter((s) => s.rendered.trim())
    .map((s) => `<section><h${s.level + 1}>${esc(s.heading)}</h${s.level + 1}>${renderMarkdown(s.rendered, { katex: opts.katex })}</section>`)
    .join("\n");
  const refs = bib.entries();
  const refHtml = refs.length ? `<section class="references"><h2>References</h2><ol class="${bib.style === "ieee" ? "numeric" : "hanging"}">${refs.map((e) => `<li>${e.html}</li>`).join("")}</ol></section>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(paper.title)}</title>${opts.katexCss ? `<link rel="stylesheet" href="${esc(opts.katexCss)}">` : ""}<style>body{font:12pt/1.5 "Times New Roman",serif;max-width:7in;margin:1in auto;color:#111}h1{text-align:center}.authors{text-align:center}.hanging{list-style:none;padding:0}.hanging li{padding-left:2em;text-indent:-2em}cite{font-style:normal}@media print{body{margin:0}}</style></head><body><h1>${esc(paper.title)}</h1>${paper.authors.length ? `<p class="authors">${paper.authors.map((a) => esc(a.name)).join(", ")}</p>` : ""}${body}${refHtml}</body></html>`;
}
