import type { PMMark, PMNode } from './doc.js';

/** Inline Markdown: **bold**, *italic*, `code`, $math$, [text](url), [@key; @key2] citations. */
export function inlineMd(text: string): PMNode[] {
  const out: PMNode[] = [];
  const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|`([^`]+)`|\$([^$]+)\$|\[(@[^\]]+)\]|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  const push = (t: string, marks?: PMMark[]) => {
    if (t) out.push(marks?.length ? { type: 'text', text: t, marks } : { type: 'text', text: t });
  };
  for (const m of text.matchAll(re)) {
    push(text.slice(last, m.index));
    if (m[2]) push(m[2], [{ type: 'bold' }]);
    else if (m[3] || m[4]) push(m[3] ?? m[4], [{ type: 'italic' }]);
    else if (m[5]) push(m[5], [{ type: 'code' }]);
    else if (m[6]) out.push({ type: 'mathInline', attrs: { latex: m[6] } });
    else if (m[7]) out.push({ type: 'citation', attrs: { ids: m[7].split(/[;,]/).map((s) => s.trim().replace(/^@/, '')).filter(Boolean) } });
    else if (m[8]) push(m[8], [{ type: 'link', attrs: { href: m[9] } }]);
    last = (m.index ?? 0) + m[0].length;
  }
  push(text.slice(last));
  return out;
}

const para = (t: string): PMNode => {
  const c = inlineMd(t);
  return c.length ? { type: 'paragraph', content: c } : { type: 'paragraph' };
};

/** Block Markdown to a Writer document. Headings shift down one level when the file starts with a single # title. */
export function markdownToDoc(md: string, title?: string): PMNode {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const content: PMNode[] = [];
  if (title) content.push({ type: 'paragraph', attrs: { styleName: 'title', textAlign: 'center' }, content: [{ type: 'text', text: title }] });
  let i = 0;
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) content.push(para(buf.join(' ').trim()));
    buf = [];
  };
  while (i < lines.length) {
    const l = lines[i];
    const fence = l.match(/^```(\w*)/);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) code.push(lines[i++]);
      i++;
      content.push({ type: 'codeBlock', attrs: { language: fence[1] || null }, content: code.length ? [{ type: 'text', text: code.join('\n') }] : undefined });
      continue;
    }
    if (/^\$\$\s*$/.test(l)) {
      flush();
      const tex: string[] = [];
      i++;
      while (i < lines.length && !/^\$\$\s*$/.test(lines[i])) tex.push(lines[i++]);
      i++;
      content.push({ type: 'mathBlock', attrs: { latex: tex.join('\n') } });
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      if (h[1].length === 1 && !title && !content.length) content.push({ type: 'paragraph', attrs: { styleName: 'title', textAlign: 'center' }, content: inlineMd(h[2]) });
      else content.push({ type: 'heading', attrs: { level: Math.min(3, Math.max(1, h[1].length - (title || content[0]?.attrs?.styleName === 'title' ? 1 : 0))) }, content: inlineMd(h[2]) });
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      flush();
      const ordered = /^\s*\d/.test(l);
      const items: PMNode[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        items.push({ type: 'listItem', content: [para(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''))] });
        i++;
      }
      content.push({ type: ordered ? 'orderedList' : 'bulletList', content: items });
      continue;
    }
    if (/^>\s?/.test(l)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''));
      content.push({ type: 'blockquote', content: q.join('\n').split(/\n\s*\n/).map((p) => para(p.replace(/\n/g, ' '))) });
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(l)) {
      flush();
      content.push({ type: 'horizontalRule' });
      i++;
      continue;
    }
    if (!l.trim()) flush();
    else buf.push(l.trim());
    i++;
  }
  flush();
  if (/\[@/.test(md)) content.push({ type: 'bibliography' });
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}
