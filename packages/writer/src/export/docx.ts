import type { PMNode } from '../doc.js';
import { bibliographyFor, type ExportContext } from './text.js';

/**
 * Word (.docx) export with real Word styles (Title, Heading 1–3, Quote,
 * numbered and bulleted lists, tables, page breaks), so the file stays
 * editable in Word, Google Docs and LibreOffice. `docx` is loaded lazily.
 */
export async function toDocx(doc: PMNode, ctx: ExportContext): Promise<Blob | Uint8Array> {
  const d = await import('docx');
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, PageBreak, ExternalHyperlink, ImageRun, LevelFormat } = d;
  const bib = bibliographyFor(doc, ctx);
  const align = (a: unknown) =>
    a === 'center' ? AlignmentType.CENTER : a === 'right' ? AlignmentType.RIGHT : a === 'justify' ? AlignmentType.JUSTIFIED : undefined;

  const runs = (n: PMNode, extra: Record<string, unknown> = {}): unknown[] => {
    if (n.type === 'text') {
      const o: Record<string, unknown> = { text: n.text ?? '', ...extra };
      let href: string | undefined;
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') o.bold = true;
        if (m.type === 'italic') o.italics = true;
        if (m.type === 'underline') o.underline = {};
        if (m.type === 'strike') o.strike = true;
        if (m.type === 'subscript') o.subScript = true;
        if (m.type === 'superscript') o.superScript = true;
        if (m.type === 'code') o.font = 'Consolas';
        if (m.type === 'highlight') o.highlight = 'yellow';
        if (m.type === 'textStyle') {
          if (m.attrs?.color) o.color = String(m.attrs.color).replace('#', '');
          if (m.attrs?.fontFamily) o.font = String(m.attrs.fontFamily).split(',')[0].replace(/['"]/g, '');
          const fs = String(m.attrs?.fontSize ?? '').match(/([\d.]+)pt/);
          if (fs) o.size = Math.round(Number(fs[1]) * 2);
        }
        if (m.type === 'link') href = String(m.attrs?.href ?? '');
      }
      const run = new TextRun(o as never);
      return href ? [new ExternalHyperlink({ link: href, children: [new TextRun({ ...(o as object), style: 'Hyperlink' } as never)] })] : [run];
    }
    if (n.type === 'hardBreak') return [new TextRun({ text: '', break: 1 })];
    if (n.type === 'citation') return [new TextRun({ text: bib.cite((n.attrs?.ids as string[]) ?? []), ...extra } as never)];
    if (n.type === 'mathInline') return [new TextRun({ text: String(n.attrs?.latex ?? ''), font: 'Cambria Math', italics: true })];
    return (n.content ?? []).flatMap((c) => runs(c, extra));
  };

  const imageRun = (src: string): unknown | null => {
    const m = src.match(/^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/);
    if (!m) return null;
    const bin = typeof atob === 'function' ? Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)) : Uint8Array.from(Buffer.from(m[2], 'base64'));
    return new ImageRun({ type: m[1] === 'jpeg' || m[1] === 'jpg' ? 'jpg' : (m[1] as 'png'), data: bin, transformation: { width: 480, height: 320 } } as never);
  };

  const out: unknown[] = [];
  const para = (n: PMNode, opts: Record<string, unknown> = {}) => {
    const s = String(n.attrs?.styleName ?? '');
    if (s === 'hint') return;
    const indent = Number(n.attrs?.indent ?? 0);
    const style = s === 'title' ? 'Title' : s === 'subtitle' ? 'Subtitle' : s === 'caption' ? 'Caption' : s === 'abstract' ? 'Abstract' : undefined;
    out.push(
      new Paragraph({
        children: runs(n, s === 'abstract-label' ? { bold: true } : {}) as never,
        alignment: align(n.attrs?.textAlign) ?? (s === 'abstract-label' ? AlignmentType.CENTER : undefined),
        indent: indent || n.attrs?.firstLine ? { left: indent * 720, firstLine: n.attrs?.firstLine ? 720 : undefined } : undefined,
        spacing: n.attrs?.lineHeight ? { line: Math.round(Number(n.attrs.lineHeight) * 240) } : undefined,
        style,
        ...opts,
      } as never),
    );
  };
  const list = (n: PMNode, ref: string, level: number) => {
    for (const item of n.content ?? []) {
      for (const c of item.content ?? []) {
        if (c.type === 'bulletList' || c.type === 'taskList') list(c, 'bullets', level + 1);
        else if (c.type === 'orderedList') list(c, 'numbers', level + 1);
        else if (c.type === 'paragraph') {
          const prefix = item.type === 'taskItem' ? (item.attrs?.checked ? '☑ ' : '☐ ') : '';
          out.push(new Paragraph({ children: [new TextRun(prefix), ...(runs(c) as never[])], numbering: { reference: ref, level: Math.min(level, 8) } } as never));
        }
      }
    }
  };
  const block = (n: PMNode) => {
    switch (n.type) {
      case 'paragraph': return para(n);
      case 'heading': {
        const lv = Number(n.attrs?.level ?? 1);
        return void out.push(new Paragraph({ children: runs(n) as never, heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][Math.min(2, lv - 1)], alignment: align(n.attrs?.textAlign) }));
      }
      case 'blockquote': return (n.content ?? []).forEach((c) => (c.type === 'paragraph' ? para(c, { style: 'Quote' }) : block(c)));
      case 'bulletList':
      case 'taskList': return list(n, 'bullets', 0);
      case 'orderedList': return list(n, 'numbers', 0);
      case 'codeBlock':
        return void ((n.content ?? []).map((c) => c.text ?? '').join('').split('\n').forEach((line) => out.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas', size: 19 })], shading: { fill: 'F2F2F2' } } as never))));
      case 'pageBreak': return void out.push(new Paragraph({ children: [new PageBreak()] }));
      case 'horizontalRule': return void out.push(new Paragraph({ border: { bottom: { color: '999999', space: 1, style: 'single', size: 6 } } } as never));
      case 'mathBlock': return void out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: String(n.attrs?.latex ?? ''), font: 'Cambria Math', italics: true })] }));
      case 'image': {
        const r = imageRun(String(n.attrs?.src ?? ''));
        if (r) out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [r as never] }));
        return;
      }
      case 'table': {
        const rows = (n.content ?? []).map(
          (r) =>
            new TableRow({
              children: (r.content ?? []).map((c) => new TableCell({ children: (c.content ?? []).map((p) => new Paragraph({ children: runs(p, c.type === 'tableHeader' ? { bold: true } : {}) as never })) })),
            }),
        );
        out.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        return void out.push(new Paragraph(''));
      }
      case 'bibliography': {
        const entries = bib.entries();
        if (!entries.length) return;
        out.push(new Paragraph({ text: 'References', heading: HeadingLevel.HEADING_1 }));
        for (const e of entries) out.push(new Paragraph({ children: [new TextRun((e.label ? e.label + ' ' : '') + e.text)], indent: { left: 720, hanging: 720 } }));
        return;
      }
      default:
        (n.content ?? []).forEach(block);
    }
  };
  (doc.content ?? []).forEach(block);

  const font = ctx.font ?? 'Times New Roman';
  const document = new Document({
    title: ctx.title,
    creator: 'AETHER Writer',
    styles: {
      default: { document: { run: { font, size: 24 }, paragraph: { spacing: { after: 160, line: 300 } } } },
      paragraphStyles: [
        { id: 'Abstract', name: 'Abstract', basedOn: 'Normal', run: { size: 21 }, paragraph: { indent: { left: 567, right: 567 }, alignment: AlignmentType.JUSTIFIED } },
        { id: 'Quote', name: 'Quote', basedOn: 'Normal', run: { italics: true, color: '444444' }, paragraph: { indent: { left: 720 } } },
      ],
    },
    numbering: {
      config: [
        { reference: 'bullets', levels: Array.from({ length: 9 }, (_, i) => ({ level: i, format: LevelFormat.BULLET, text: ['•', '◦', '▪'][i % 3], alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } } })) },
        { reference: 'numbers', levels: Array.from({ length: 9 }, (_, i) => ({ level: i, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][i % 3], text: `%${i + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } } })) },
      ],
    },
    sections: [{ properties: { page: { margin: { top: 1418, bottom: 1418, left: 1418, right: 1418 } } }, children: out as never }],
  } as never);
  return typeof window === 'undefined' ? new Uint8Array(await Packer.toBuffer(document)) : await Packer.toBlob(document);
}
