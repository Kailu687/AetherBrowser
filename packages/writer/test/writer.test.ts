import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { aiCheck, blocks, docStats, DOC_TEMPLATES, outline, recommend, sentences, toHtml, toLatex, toMarkdown, WRITER_MIGRATIONS, WriterStore, type PMNode } from '../src/index.js';
import { toDocx } from '../src/export/docx.js';

const t = (text: string): PMNode => ({ type: 'text', text });
const para = (...c: PMNode[]): PMNode => ({ type: 'paragraph', content: c });
const head = (level: number, text: string): PMNode => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const lib = new Map([['smith2020', { id: 'smith2020', type: 'article-journal' as const, title: 'On things', author: [{ family: 'Smith', given: 'J.' }], issued: { 'date-parts': [[2020]] }, 'container-title': 'Journal' }]]);

const doc: PMNode = {
  type: 'doc',
  content: [
    { type: 'paragraph', attrs: { styleName: 'title' }, content: [t('A Study')] },
    head(1, 'Introduction'),
    para(t('Studies show that 70% of circuits fail. '), { type: 'citation', attrs: { ids: ['smith2020'] } }, t(' We measured the LDO output.')),
    head(3, 'Deep'),
    para(t('Text with the the repetition.')),
    { type: 'bibliography' },
  ],
};

describe('writer document model', () => {
  it('extracts blocks, outline and stats', () => {
    expect(blocks(doc)[2].cites).toEqual(['smith2020']);
    expect(outline(doc).map((o) => o.text)).toEqual(['Introduction', 'Deep']);
    expect(docStats(doc).citations).toBe(1);
    expect(sentences('We used e.g. a 3.3 V rail. It worked! Fig. 2 shows it.')).toHaveLength(3);
  });
  it('templates build valid documents', () => {
    for (const tpl of DOC_TEMPLATES) expect(tpl.build('T').type).toBe('doc');
  });
});

describe('recommendation engine', () => {
  it('flags missing sections, skipped headings, undefined acronyms and repeats', () => {
    const s = recommend(doc, { kind: 'paper' });
    const msgs = s.map((x) => x.message).join('\n');
    expect(msgs).toMatch(/Add a “Method” section/);
    expect(msgs).toMatch(/skips a level/);
    expect(msgs).toMatch(/“LDO” is used without being defined/);
    expect(msgs).toMatch(/Repeated word/);
    expect(msgs).not.toMatch(/Add a “Introduction”/);
  });
  it('flags uncited claims only when no citation is present', () => {
    const d: PMNode = { type: 'doc', content: [head(1, 'Introduction'), para(t('Research shows that most engineers prefer tea.'))] };
    expect(recommend(d, { kind: 'paper' }).some((x) => x.category === 'evidence' && x.quote)).toBe(true);
  });
});

describe('AI-likeness indicator', () => {
  it('refuses to score short text', () => {
    expect(aiCheck('Too short.').band).toBe('too-short');
  });
  it('scores stock-phrase-heavy uniform text higher than varied concrete text', () => {
    const ai = Array.from({ length: 8 }, () => 'Furthermore, it is important to note that this robust framework plays a crucial role in the ever-evolving landscape of modern engineering.').join(' ');
    const human = 'I soldered the board at 2 am. It failed. We then measured 3.3 V on the rail, 40 mV of ripple and a 12 °C rise on the regulator, which surprised everyone in the lab because the datasheet promised far less. Odd. My guess is the layout: the ground return runs under the inductor. Next week we will reroute it and measure again with the scope set to 20 MHz bandwidth, then compare against the simulation (Smith, 2020).';
    const a = aiCheck(ai);
    const b = aiCheck(human + ' ' + human);
    expect(a.score!).toBeGreaterThan(b.score!);
    expect(a.flagged.length).toBeGreaterThan(0);
    expect(a.disclaimer).toMatch(/not proof/);
  });
});

describe('exports', () => {
  const ctx = { title: 'A Study', style: 'apa' as const, library: lib };
  it('renders citations and bibliography to HTML and Markdown', () => {
    const html = toHtml(doc, ctx, { standalone: true });
    expect(html).toContain('(Smith, 2020)');
    expect(html).toContain('References');
    expect(toMarkdown(doc, ctx)).toContain('## Introduction');
  });
  it('produces LaTeX with \\cite and a .bib entry', () => {
    const { tex, bib } = toLatex(doc, { ...ctx, style: 'ieee' });
    expect(tex).toContain('\\cite{smith2020}');
    expect(tex).toContain('IEEEtran');
    expect(bib).toContain('@article{smith2020');
  });
  it('writes a .docx (zip) file', async () => {
    const bytes = (await toDocx(doc, ctx)) as Uint8Array;
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });
});

describe('writer store', () => {
  it('creates, updates, versions and restores', () => {
    const db = new DatabaseSync(':memory:');
    for (const m of WRITER_MIGRATIONS) db.exec(m.up);
    const s = new WriterStore(db as never);
    const d = s.create('p', { title: 'X', content: doc });
    expect(s.list('p')).toHaveLength(1);
    expect(s.list('q')).toHaveLength(0);
    s.snapshot('p', d.id, 'v1');
    s.update('p', d.id, { content: { type: 'doc', content: [para(t('new'))] } });
    expect(s.get('p', d.id)!.words).toBe(1);
    const v = s.versions('p', d.id)[0];
    s.restore('p', d.id, v.id);
    expect(s.get('p', d.id)!.content.content).toHaveLength(6);
    expect(s.delete('p', d.id)).toBe(true);
  });
});

import { markdownToDoc } from '../src/markdown-import.js';
describe('markdown import', () => {
  it('converts headings, lists, citations and math', () => {
    const d = markdownToDoc('# Review\n\n## Background\n\nText with **bold** and [@a; @b] and $x^2$.\n\n- one\n- two\n\n> quoted', undefined);
    expect(d.content![0].attrs!.styleName).toBe('title');
    expect(d.content![1]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    const p = d.content![2].content!;
    expect(p.find((n) => n.type === 'citation')!.attrs!.ids).toEqual(['a', 'b']);
    expect(p.some((n) => n.type === 'mathInline')).toBe(true);
    expect(d.content!.some((n) => n.type === 'bulletList')).toBe(true);
    expect(d.content!.at(-1)!.type).toBe('bibliography');
  });
});
