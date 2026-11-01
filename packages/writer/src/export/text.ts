import type { Reference, StyleId } from '@aether/citations';
import { Bibliography } from '@aether/citations';
import type { PMMark, PMNode } from '../doc.js';
import { citationOrder } from '../doc.js';

export interface ExportContext {
  title: string;
  style: StyleId;
  library: Map<string, Reference>;
  font?: string;
}

/** Builds a bibliography whose citation order follows the document. */
export function bibliographyFor(doc: PMNode, ctx: ExportContext): Bibliography {
  const bib = new Bibliography(ctx.style, [...ctx.library.values()]);
  for (const id of citationOrder(doc)) if (ctx.library.has(id)) bib.cite(id);
  return bib;
}

export function citeText(bib: Bibliography, ids: string[]): string {
  return bib.cite(ids);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------- HTML

function wrapMarks(html: string, marks: PMMark[] = []): string {
  for (const m of marks) {
    switch (m.type) {
      case 'bold': html = `<strong>${html}</strong>`; break;
      case 'italic': html = `<em>${html}</em>`; break;
      case 'underline': html = `<u>${html}</u>`; break;
      case 'strike': html = `<s>${html}</s>`; break;
      case 'code': html = `<code>${html}</code>`; break;
      case 'subscript': html = `<sub>${html}</sub>`; break;
      case 'superscript': html = `<sup>${html}</sup>`; break;
      case 'highlight': html = `<mark>${html}</mark>`; break;
      case 'link': html = `<a href="${esc(String(m.attrs?.href ?? ''))}">${html}</a>`; break;
      case 'textStyle': {
        const st: string[] = [];
        if (m.attrs?.color) st.push(`color:${m.attrs.color}`);
        if (m.attrs?.fontFamily) st.push(`font-family:${m.attrs.fontFamily}`);
        if (m.attrs?.fontSize) st.push(`font-size:${m.attrs.fontSize}`);
        if (st.length) html = `<span style="${esc(st.join(';'))}">${html}</span>`;
        break;
      }
    }
  }
  return html;
}

function blockStyle(n: PMNode): string {
  const st: string[] = [];
  const a = n.attrs ?? {};
  if (a.textAlign && a.textAlign !== 'left') st.push(`text-align:${a.textAlign}`);
  if (Number(a.indent)) st.push(`margin-left:${Number(a.indent) * 2}em`);
  if (a.firstLine) st.push('text-indent:2em');
  if (a.lineHeight) st.push(`line-height:${a.lineHeight}`);
  return st.length ? ` style="${st.join(';')}"` : '';
}

export function toHtml(doc: PMNode, ctx: ExportContext, opts: { standalone?: boolean; katex?: (tex: string, display: boolean) => string } = {}): string {
  const bib = bibliographyFor(doc, ctx);
  const math = opts.katex ?? ((t: string, d: boolean) => (d ? `<div class="math">\\[${esc(t)}\\]</div>` : `<span class="math">\\(${esc(t)}\\)</span>`));
  const inline = (n: PMNode): string => {
    if (n.type === 'text') return wrapMarks(esc(n.text ?? ''), n.marks);
    if (n.type === 'hardBreak') return '<br>';
    if (n.type === 'citation') return `<span class="cite">${esc(bib.cite((n.attrs?.ids as string[]) ?? []))}</span>`;
    if (n.type === 'mathInline') return math(String(n.attrs?.latex ?? ''), false);
    return (n.content ?? []).map(inline).join('');
  };
  const block = (n: PMNode): string => {
    const kids = () => (n.content ?? []).map(block).join('');
    const inl = () => (n.content ?? []).map(inline).join('');
    switch (n.type) {
      case 'doc': return kids();
      case 'paragraph': {
        const s = String(n.attrs?.styleName ?? '');
        if (s === 'hint') return '';
        return `<p${s ? ` class="${esc(s)}"` : ''}${blockStyle(n)}>${inl() || '<br>'}</p>`;
      }
      case 'heading': return `<h${n.attrs?.level ?? 1}${blockStyle(n)}>${inl()}</h${n.attrs?.level ?? 1}>`;
      case 'blockquote': return `<blockquote>${kids()}</blockquote>`;
      case 'bulletList': return `<ul>${kids()}</ul>`;
      case 'orderedList': return `<ol${n.attrs?.start && n.attrs.start !== 1 ? ` start="${n.attrs.start}"` : ''}>${kids()}</ol>`;
      case 'taskList': return `<ul class="tasks">${kids()}</ul>`;
      case 'listItem': return `<li>${kids()}</li>`;
      case 'taskItem': return `<li>${n.attrs?.checked ? '☑' : '☐'} ${kids()}</li>`;
      case 'codeBlock': return `<pre><code>${esc((n.content ?? []).map((c) => c.text ?? '').join(''))}</code></pre>`;
      case 'horizontalRule': return '<hr>';
      case 'pageBreak': return '<div class="page-break"></div>';
      case 'image': return `<figure><img src="${esc(String(n.attrs?.src ?? ''))}" alt="${esc(String(n.attrs?.alt ?? ''))}"></figure>`;
      case 'mathBlock': return math(String(n.attrs?.latex ?? ''), true);
      case 'table': return `<table>${kids()}</table>`;
      case 'tableRow': return `<tr>${kids()}</tr>`;
      case 'tableHeader': return `<th>${kids()}</th>`;
      case 'tableCell': return `<td>${kids()}</td>`;
      case 'bibliography': {
        const entries = bib.entries();
        if (!entries.length) return '';
        return `<h1>References</h1><ol class="refs${bib.style === 'ieee' ? ' numeric' : ''}">${entries.map((e) => `<li>${e.label ? `<span class="lbl">${e.label}</span> ` : ''}${e.html}</li>`).join('')}</ol>`;
      }
      default: return kids() || inl();
    }
  };
  const body = block(doc);
  if (!opts.standalone) return body;
  const font = ctx.font ?? 'Times New Roman';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(ctx.title)}</title><style>
@page{size:A4;margin:25mm}body{font-family:'${font}',serif;font-size:12pt;line-height:1.5;color:#111;max-width:170mm;margin:0 auto}
h1{font-size:15pt;margin:18pt 0 6pt}h2{font-size:13pt}h3{font-size:12pt;font-style:italic}p{margin:0 0 8pt}
.title{font-size:20pt;font-weight:700;text-align:center;margin-bottom:4pt}.subtitle{text-align:center;color:#444}.abstract-label{font-weight:700;text-align:center}
.abstract{font-size:10.5pt;margin:0 8mm 12pt;text-align:justify}.keywords{font-style:italic;font-size:10.5pt}.caption{font-size:10pt;text-align:center;color:#333}
blockquote{margin:0 0 8pt 8mm;padding-left:4mm;border-left:2px solid #999;color:#333}table{border-collapse:collapse;margin:8pt auto}td,th{border:1px solid #777;padding:3pt 6pt}
figure{text-align:center;margin:10pt 0}img{max-width:100%}pre{background:#f4f4f4;padding:6pt;font-size:9.5pt;white-space:pre-wrap}.page-break{break-after:page}
ol.refs{padding-left:0;list-style:none}ol.refs li{margin-bottom:5pt;padding-left:2em;text-indent:-2em}
</style></head><body>${body}</body></html>`;
}

// ---------------------------------------------------------------------------- Markdown

export function toMarkdown(doc: PMNode, ctx: ExportContext): string {
  const bib = bibliographyFor(doc, ctx);
  const inline = (n: PMNode): string => {
    if (n.type === 'text') {
      let t = n.text ?? '';
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `**${t}**`;
        else if (m.type === 'italic') t = `*${t}*`;
        else if (m.type === 'code') t = `\`${t}\``;
        else if (m.type === 'strike') t = `~~${t}~~`;
        else if (m.type === 'link') t = `[${t}](${m.attrs?.href})`;
        else if (m.type === 'subscript') t = `~${t}~`;
        else if (m.type === 'superscript') t = `^${t}^`;
      }
      return t;
    }
    if (n.type === 'hardBreak') return '  \n';
    if (n.type === 'citation') return bib.cite((n.attrs?.ids as string[]) ?? []);
    if (n.type === 'mathInline') return `$${n.attrs?.latex}$`;
    return (n.content ?? []).map(inline).join('');
  };
  const block = (n: PMNode, depth = 0, ordered = false, idx = 1): string => {
    const inl = () => (n.content ?? []).map(inline).join('');
    switch (n.type) {
      case 'doc': return (n.content ?? []).map((c) => block(c)).filter(Boolean).join('\n\n') + '\n';
      case 'paragraph': {
        const s = n.attrs?.styleName;
        if (s === 'hint') return '';
        if (s === 'title') return `# ${inl()}`;
        return inl();
      }
      case 'heading': return `${'#'.repeat(Math.min(6, Number(n.attrs?.level ?? 1) + 1))} ${inl()}`;
      case 'blockquote': return (n.content ?? []).map((c) => block(c)).join('\n\n').split('\n').map((l) => `> ${l}`).join('\n');
      case 'bulletList':
      case 'taskList': return (n.content ?? []).map((c) => block(c, depth, false)).join('\n');
      case 'orderedList': return (n.content ?? []).map((c, i) => block(c, depth, true, i + 1)).join('\n');
      case 'listItem':
      case 'taskItem': {
        const [first, ...rest] = n.content ?? [];
        const pre = '  '.repeat(depth) + (ordered ? `${idx}. ` : '- ') + (n.type === 'taskItem' ? (n.attrs?.checked ? '[x] ' : '[ ] ') : '');
        const restMd = rest.map((c) => (c.type.endsWith('List') ? (c.content ?? []).map((cc, i) => block(cc, depth + 1, c.type === 'orderedList', i + 1)).join('\n') : '  '.repeat(depth + 1) + block(c))).join('\n');
        return pre + (first ? block(first) : '') + (restMd ? '\n' + restMd : '');
      }
      case 'codeBlock': return '```' + (n.attrs?.language ?? '') + '\n' + (n.content ?? []).map((c) => c.text ?? '').join('') + '\n```';
      case 'horizontalRule':
      case 'pageBreak': return '---';
      case 'image': return `![${n.attrs?.alt ?? ''}](${String(n.attrs?.src ?? '').startsWith('data:') ? 'image' : n.attrs?.src})`;
      case 'mathBlock': return `$$\n${n.attrs?.latex}\n$$`;
      case 'table': {
        const rows = (n.content ?? []).map((r) => (r.content ?? []).map((c) => (c.content ?? []).map((x) => block(x)).join(' ').replace(/\|/g, '\\|')));
        if (!rows.length) return '';
        const head = `| ${rows[0].join(' | ')} |\n| ${rows[0].map(() => '---').join(' | ')} |`;
        return [head, ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`)].join('\n');
      }
      case 'bibliography': {
        const e = bib.entries();
        return e.length ? `## References\n\n${e.map((x) => `${x.label ? x.label + ' ' : '- '}${x.markdown}`).join('\n')}` : '';
      }
      default: return inl();
    }
  };
  return block(doc);
}

// ---------------------------------------------------------------------------- LaTeX

const tex = (s: string) => s.replace(/\\/g, '\\textbackslash{}').replace(/([#$%&_{}])/g, '\\$1').replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}');

export function toLatex(doc: PMNode, ctx: ExportContext): { tex: string; bib: string } {
  const used = new Set<string>();
  const inline = (n: PMNode): string => {
    if (n.type === 'text') {
      let t = tex(n.text ?? '');
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `\\textbf{${t}}`;
        else if (m.type === 'italic') t = `\\emph{${t}}`;
        else if (m.type === 'underline') t = `\\underline{${t}}`;
        else if (m.type === 'code') t = `\\texttt{${t}}`;
        else if (m.type === 'subscript') t = `\\textsubscript{${t}}`;
        else if (m.type === 'superscript') t = `\\textsuperscript{${t}}`;
        else if (m.type === 'link') t = `\\href{${m.attrs?.href}}{${t}}`;
      }
      return t;
    }
    if (n.type === 'hardBreak') return '\\\\\n';
    if (n.type === 'citation') {
      const ids = (n.attrs?.ids as string[]) ?? [];
      ids.forEach((i) => used.add(i));
      return `\\cite{${ids.join(',')}}`;
    }
    if (n.type === 'mathInline') return `$${n.attrs?.latex}$`;
    return (n.content ?? []).map(inline).join('');
  };
  let title = ctx.title;
  let author = '';
  let abstract = '';
  const block = (n: PMNode): string => {
    const kids = () => (n.content ?? []).map(block).join('\n');
    const inl = () => (n.content ?? []).map(inline).join('');
    switch (n.type) {
      case 'doc': return kids();
      case 'paragraph': {
        const s = n.attrs?.styleName;
        if (s === 'hint' || s === 'abstract-label') return '';
        if (s === 'title') { title = inl(); return ''; }
        if (s === 'subtitle') { author = inl(); return ''; }
        if (s === 'abstract') { abstract += inl() + '\n'; return ''; }
        const al = n.attrs?.textAlign;
        const body = inl() + '\n';
        return al === 'center' ? `\\begin{center}\n${body}\\end{center}\n` : al === 'right' ? `\\begin{flushright}\n${body}\\end{flushright}\n` : body;
      }
      case 'heading': return `\\${['section', 'subsection', 'subsubsection'][Math.min(2, Number(n.attrs?.level ?? 1) - 1)]}{${inl()}}\n`;
      case 'blockquote': return `\\begin{quote}\n${kids()}\\end{quote}\n`;
      case 'bulletList':
      case 'taskList': return `\\begin{itemize}\n${kids()}\\end{itemize}\n`;
      case 'orderedList': return `\\begin{enumerate}\n${kids()}\\end{enumerate}\n`;
      case 'listItem':
      case 'taskItem': return `\\item ${kids()}`;
      case 'codeBlock': return `\\begin{verbatim}\n${(n.content ?? []).map((c) => c.text ?? '').join('')}\n\\end{verbatim}\n`;
      case 'mathBlock': return `\\begin{equation}\n${n.attrs?.latex}\n\\end{equation}\n`;
      case 'pageBreak': return '\\newpage\n';
      case 'horizontalRule': return '\\noindent\\rule{\\linewidth}{0.4pt}\n';
      case 'image': return `% figure: ${tex(String(n.attrs?.alt ?? 'image'))} (export images separately)\n`;
      case 'table': {
        const rows = (n.content ?? []).map((r) => (r.content ?? []).map((c) => (c.content ?? []).map((x) => (x.content ?? []).map(inline).join('')).join(' ')));
        const cols = Math.max(1, ...rows.map((r) => r.length));
        return `\\begin{table}[h]\n\\centering\n\\begin{tabular}{${'|l'.repeat(cols)}|}\n\\hline\n${rows.map((r) => r.join(' & ') + ' \\\\ \\hline').join('\n')}\n\\end{tabular}\n\\end{table}\n`;
      }
      case 'bibliography': return ctx.style === 'ieee' ? '\\bibliographystyle{IEEEtran}\n\\bibliography{references}\n' : '\\bibliographystyle{apalike}\n\\bibliography{references}\n';
      default: return inl();
    }
  };
  const body = block(doc);
  const ieee = ctx.style === 'ieee';
  const out = `\\documentclass${ieee ? '[conference]{IEEEtran}' : '[12pt]{article}'}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath,amssymb,graphicx,hyperref${ieee ? ',cite' : ''}}
\\title{${title}}
\\author{${author}}
\\begin{document}
\\maketitle
${abstract ? `\\begin{abstract}\n${abstract}\\end{abstract}\n` : ''}${body}
\\end{document}
`;
  return { tex: out, bib: [...used].filter((id) => ctx.library.has(id)).map((id) => refToBibtex(ctx.library.get(id)!)).join('\n\n') };
}

function refToBibtex(r: Reference): string {
  const type = r.type === 'article-journal' ? 'article' : r.type === 'paper-conference' ? 'inproceedings' : r.type === 'book' ? 'book' : r.type === 'thesis' ? 'phdthesis' : r.type === 'report' ? 'techreport' : 'misc';
  const authors = (r.author ?? []).map((a) => a.literal ?? [a.family, a.given].filter(Boolean).join(', ')).join(' and ');
  const year = r.issued?.['date-parts']?.[0]?.[0];
  const f: [string, unknown][] = [
    ['author', authors], ['title', r.title], ['journal', r.type === 'article-journal' ? r['container-title'] : undefined], ['booktitle', r.type === 'paper-conference' ? r['container-title'] : undefined],
    ['year', year], ['volume', r.volume], ['number', r.issue], ['pages', r.page], ['publisher', r.publisher], ['doi', r.DOI], ['url', r.URL],
  ];
  return `@${type}{${r.id},\n${f.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `  ${k} = {${v}}`).join(',\n')}\n}`;
}

export function toPlainText(doc: PMNode, ctx: ExportContext): string {
  return toMarkdown(doc, ctx).replace(/[*_`~^]/g, '').replace(/^#+\s/gm, '');
}
