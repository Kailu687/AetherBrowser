/** ProseMirror/TipTap JSON, the on-disk format of Writer documents. */
export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: PMMark[];
  text?: string;
}

export interface Block {
  /** Index among top-level blocks. */
  index: number;
  type: 'heading' | 'paragraph' | 'quote' | 'list' | 'code' | 'table' | 'math' | 'figure' | 'other';
  level?: number;
  /** Paragraph style name (title, subtitle, caption, abstract...). */
  style?: string;
  text: string;
  /** Citation keys used inside this block. */
  cites: string[];
}

export const emptyDoc = (): PMNode => ({ type: 'doc', content: [{ type: 'paragraph' }] });

/** Plain text of a node; citations become "[@key]", math becomes "$tex$". */
export function nodeText(n: PMNode): string {
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'citation') return `[@${((n.attrs?.ids as string[]) ?? []).join('; @')}]`;
  if (n.type === 'mathInline') return `$${(n.attrs?.latex as string) ?? ''}$`;
  if (n.type === 'hardBreak') return '\n';
  const parts = (n.content ?? []).map(nodeText);
  const blockish = ['bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'table', 'tableRow', 'blockquote'];
  return parts.join(blockish.includes(n.type) ? '\n' : n.type === 'tableCell' || n.type === 'tableHeader' ? ' ' : '');
}

export function collectCites(n: PMNode, out: string[] = []): string[] {
  if (n.type === 'citation') for (const id of (n.attrs?.ids as string[]) ?? []) out.push(id);
  for (const c of n.content ?? []) collectCites(c, out);
  return out;
}

export function blocks(doc: PMNode): Block[] {
  return (doc.content ?? []).map((n, index) => {
    const text = nodeText(n);
    const cites = collectCites(n);
    switch (n.type) {
      case 'heading':
        return { index, type: 'heading', level: Number(n.attrs?.level ?? 1), text, cites };
      case 'paragraph':
        return { index, type: 'paragraph', style: (n.attrs?.styleName as string) || undefined, text, cites };
      case 'blockquote':
        return { index, type: 'quote', text, cites };
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        return { index, type: 'list', text, cites };
      case 'codeBlock':
        return { index, type: 'code', text, cites };
      case 'table':
        return { index, type: 'table', text, cites };
      case 'mathBlock':
        return { index, type: 'math', text, cites };
      case 'image':
        return { index, type: 'figure', text: String(n.attrs?.alt ?? ''), cites };
      default:
        return { index, type: 'other', text, cites };
    }
  });
}

export const WORD_RE = /[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu;
export const countWords = (text: string) => (text.replace(/\[@[^\]]*\]/g, '').replace(/\$[^$]*\$/g, ' x ').match(WORD_RE) ?? []).length;

export interface OutlineItem {
  index: number;
  level: number;
  text: string;
  words: number;
}

/** Headings with the word count of the text under each one. */
export function outline(doc: PMNode): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const b of blocks(doc)) {
    if (b.type === 'heading') out.push({ index: b.index, level: b.level ?? 1, text: b.text.trim() || 'Untitled section', words: 0 });
    else if (out.length && b.type !== 'code') out[out.length - 1].words += countWords(b.text);
  }
  return out;
}

export function docStats(doc: PMNode) {
  const bl = blocks(doc);
  const text = bl.filter((b) => b.type !== 'code').map((b) => b.text).join('\n');
  const words = countWords(text);
  return {
    words,
    characters: text.replace(/\s/g, '').length,
    paragraphs: bl.filter((b) => b.type === 'paragraph' && b.text.trim()).length,
    readingMinutes: Math.max(1, Math.round(words / 230)),
    citations: bl.reduce((n, b) => n + b.cites.length, 0),
  };
}

export function citationOrder(doc: PMNode): string[] {
  const seen: string[] = [];
  for (const id of collectCites(doc)) if (!seen.includes(id)) seen.push(id);
  return seen;
}

/** Sentence splitter that keeps "e.g.", "et al.", "Fig. 2" and decimals together. */
export function sentences(text: string): string[] {
  const protectedText = text
    .replace(/\b(e\.g|i\.e|et al|etc|Fig|Figs|Eq|Eqs|Dr|Mr|Mrs|Ms|Prof|vs|approx|No|Vol|pp|cf)\./gi, (m) => m.replace(/\./g, '\u0000'))
    .replace(/(\d)\.(\d)/g, '$1\u0000$2');
  return protectedText
    .split(/(?<=[.!?])["”’)\]]*\s+(?=[\p{Lu}\p{N}"“(\[])/u)
    .map((s) => s.replace(/\u0000/g, '.').trim())
    .filter((s) => s.length > 1);
}
