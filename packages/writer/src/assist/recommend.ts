import { blocks, countWords, outline, sentences, type Block, type PMNode } from '../doc.js';

export type SuggestionCategory = 'structure' | 'evidence' | 'clarity' | 'style' | 'formatting' | 'next';

export interface Suggestion {
  id: string;
  category: SuggestionCategory;
  severity: 'tip' | 'warn';
  message: string;
  /** Why it matters / how to fix. */
  fix?: string;
  /** Top-level block index the suggestion is about. */
  block?: number;
  /** Exact text to highlight inside that block. */
  quote?: string;
}

export type DocKind = 'document' | 'paper' | 'report' | 'letter' | 'review' | 'thesis' | 'lab';

export interface RecommendOptions {
  kind: DocKind;
  /** Section headings the template expects, in order. */
  expectedSections?: string[];
  /** Target word count, if any. */
  targetWords?: number;
}

const PAPER_SECTIONS = ['Abstract', 'Introduction', 'Method', 'Results', 'Discussion', 'Conclusion', 'References'];
const SECTION_ALIASES: Record<string, RegExp> = {
  abstract: /abstract|summary/i,
  introduction: /introduction|background/i,
  method: /method|methodology|materials|approach|experimental|design|implementation/i,
  results: /results|findings|evaluation|experiments/i,
  discussion: /discussion|analysis/i,
  conclusion: /conclusion|concluding|summary and future/i,
  references: /references|bibliography|works cited/i,
  'literature review': /literature|related work|prior work/i,
  limitations: /limitation|threats to validity/i,
};

const VAGUE = ['very', 'really', 'quite', 'a lot', 'lots of', 'things', 'stuff', 'basically', 'obviously', 'clearly', 'of course', 'kind of', 'sort of', 'huge', 'nice', 'good', 'bad'];
const US_UK: [RegExp, RegExp, string][] = [
  [/\b(colou?r)s?\b/i, /\bcolour/i, 'color / colour'],
  [/\banaly[sz]e/i, /\banalyse/i, 'analyze / analyse'],
  [/\b(organi[sz]ation)/i, /\borganisation/i, 'organization / organisation'],
  [/\b(behaviou?r)/i, /\bbehaviour/i, 'behavior / behaviour'],
  [/\b(modell?ing)/i, /\bmodelling/i, 'modeling / modelling'],
  [/\b(cent(er|re))\b/i, /\bcentre\b/i, 'center / centre'],
];

const sectionMatch = (heading: string, want: string) => (SECTION_ALIASES[want.toLowerCase()] ?? new RegExp(want, 'i')).test(heading);

function sectionsOf(bl: Block[]) {
  const out: { heading: string; level: number; index: number; body: Block[] }[] = [];
  for (const b of bl) {
    if (b.type === 'heading') out.push({ heading: b.text.trim(), level: b.level ?? 1, index: b.index, body: [] });
    else if (out.length) out[out.length - 1].body.push(b);
  }
  return out;
}

/**
 * The recommendation engine: offline, rule-based suggestions about what to add,
 * change or check. Each one explains itself; nothing is rewritten automatically.
 */
export function recommend(doc: PMNode, opts: RecommendOptions): Suggestion[] {
  const out: Suggestion[] = [];
  const bl = blocks(doc);
  const secs = sectionsOf(bl);
  const academic = opts.kind === 'paper' || opts.kind === 'review' || opts.kind === 'thesis' || opts.kind === 'lab' || opts.kind === 'report';
  const add = (s: Omit<Suggestion, 'id'>) => out.push({ id: `${s.category}-${out.length}`, ...s });
  const allText = bl.filter((b) => b.type !== 'code').map((b) => b.text).join('\n');
  const totalWords = countWords(allText);

  // ---- Structure
  if (academic) {
    const expected = opts.expectedSections?.length ? opts.expectedSections : PAPER_SECTIONS;
    const missing = expected.filter((want) => !secs.some((s) => sectionMatch(s.heading, want)) && !(want === 'Abstract' && bl.some((b) => b.style === 'abstract')));
    for (const m of missing)
      add({ category: 'structure', severity: m === 'References' || m === 'Introduction' ? 'warn' : 'tip', message: `Add a “${m}” section.`, fix: sectionAdvice(m) });
    const abs = secs.find((s) => sectionMatch(s.heading, 'abstract'));
    const absWords = abs ? countWords(abs.body.map((b) => b.text).join(' ')) : countWords(bl.filter((b) => b.style === 'abstract').map((b) => b.text).join(' '));
    if ((abs || bl.some((b) => b.style === 'abstract')) && (absWords < 100 || absWords > 300))
      add({ category: 'structure', severity: 'tip', block: abs?.index, message: `The abstract has ${absWords} words; most venues expect 150–250.`, fix: 'State the problem, what you did, the main result (with a number) and why it matters.' });
    const intro = secs.find((s) => sectionMatch(s.heading, 'introduction'));
    if (intro) {
      const t = intro.body.map((b) => b.text).join(' ');
      if (t && !/\b(aim|objective|goal|purpose|we propose|this (paper|report|study|work)|research question|contribution)/i.test(t))
        add({ category: 'structure', severity: 'tip', block: intro.index, message: 'The introduction does not state the aim or contribution.', fix: 'Add a sentence such as “This paper proposes…” or list your contributions.' });
    }
    const disc = secs.find((s) => sectionMatch(s.heading, 'discussion') || sectionMatch(s.heading, 'conclusion'));
    if (disc && !secs.some((s) => sectionMatch(s.heading, 'limitations')) && !/limitation|future work|further research/i.test(disc.body.map((b) => b.text).join(' ')))
      add({ category: 'next', severity: 'tip', block: disc.index, message: 'Mention limitations and future work.', fix: 'Reviewers look for an honest limits paragraph near the end.' });
    const concl = secs.find((s) => sectionMatch(s.heading, 'conclusion'));
    if (concl && concl.body.some((b) => b.cites.length))
      add({ category: 'structure', severity: 'tip', block: concl.index, message: 'The conclusion cites sources.', fix: 'Conclusions usually summarise your own findings; move new evidence to the discussion.' });
  }
  for (const s of secs) {
    const w = countWords(s.body.map((b) => b.text).join(' '));
    if (w === 0 && !sectionMatch(s.heading, 'references')) add({ category: 'next', severity: 'tip', block: s.index, message: `“${s.heading || 'Untitled'}” is empty.`, fix: 'Write a first rough paragraph; you can polish later.' });
  }
  const heads = outline(doc);
  for (let i = 1; i < heads.length; i++)
    if (heads[i].level > heads[i - 1].level + 1)
      add({ category: 'formatting', severity: 'warn', block: heads[i].index, message: `Heading “${heads[i].text}” skips a level (H${heads[i - 1].level} → H${heads[i].level}).`, fix: 'Use the next heading level so the outline and table of contents stay correct.' });

  // ---- Evidence
  let uncited = 0;
  for (const b of bl) {
    if (b.type !== 'paragraph' || b.style === 'title' || b.style === 'caption') continue;
    for (const s of sentences(b.text)) {
      const claim = /\b(studies|research|evidence|data|surveys?|experts?|scientists) (show|shows|suggest|suggests|indicate|found|prove)|\b(most|majority of|widely|commonly|it is (known|believed)|has been shown)\b|\d+(\.\d+)?\s?%/i.test(s);
      if (academic && claim && !/\[@|\(\w[^)]*\d{4}[a-z]?\)|\[\d+\]/.test(s) && uncited < 8) {
        uncited++;
        add({ category: 'evidence', severity: 'warn', block: b.index, quote: s.slice(0, 160), message: 'This sounds like a factual claim without a citation.', fix: 'Cite a source (Ctrl+Shift+C) or rephrase it as your own finding.' });
      }
    }
  }
  if (academic && totalWords > 400 && !bl.some((b) => b.cites.length))
    add({ category: 'evidence', severity: 'warn', message: 'No citations yet.', fix: 'Add references from your library; a paper of this length usually cites 10 or more sources.' });
  const figs = (allText.match(/\b(Fig(ure)?\.?|Table)\s+\d+/gi) ?? []).length;
  const images = bl.filter((b) => b.type === 'figure' || b.type === 'table').length;
  if (images > figs) add({ category: 'formatting', severity: 'tip', message: `${images} figure/table${images > 1 ? 's' : ''} but only ${figs} reference${figs === 1 ? '' : 's'} like “Figure 1” in the text.`, fix: 'Refer to every figure and table in the text, and give each a caption.' });

  // ---- Clarity
  const defined = new Set<string>();
  for (const m of allText.matchAll(/\(([A-Z][A-Za-z]{1,7}s?)\)/g)) defined.add(m[1].replace(/s$/, ''));
  const common = new Set(['I', 'A', 'AI', 'USA', 'UK', 'PDF', 'URL', 'HTML', 'CPU', 'GPU', 'DNA', 'RNA', 'PhD', 'OK', 'TV', 'ID', 'IEEE', 'APA', 'MLA', 'II', 'III', 'IV', 'USB', 'LED', 'PCB']);
  const reported = new Set<string>();
  for (const b of bl) {
    if (b.type === 'code' || b.type === 'heading') continue;
    for (const m of b.text.matchAll(/\b([A-Z]{2,6})s?\b/g)) {
      const ac = m[1];
      if (common.has(ac) || defined.has(ac) || reported.has(ac)) continue;
      const before = b.text.slice(0, m.index ?? 0);
      if (new RegExp(`\\(${ac}\\)`).test(before)) continue;
      reported.add(ac);
      if (reported.size <= 5) add({ category: 'clarity', severity: 'tip', block: b.index, quote: ac, message: `“${ac}” is used without being defined.`, fix: `Spell it out on first use, e.g. “Full Name (${ac})”.` });
    }
  }
  let longCount = 0;
  let passive = 0;
  let totalSents = 0;
  for (const b of bl) {
    if (b.type !== 'paragraph') continue;
    const w = countWords(b.text);
    if (w > 220) add({ category: 'clarity', severity: 'tip', block: b.index, quote: b.text.slice(0, 80), message: `A ${w}-word paragraph.`, fix: 'Split it so each paragraph makes one point.' });
    for (const s of sentences(b.text)) {
      totalSents++;
      const n = countWords(s);
      if (n > 38 && longCount < 6) {
        longCount++;
        add({ category: 'clarity', severity: 'tip', block: b.index, quote: s.slice(0, 160), message: `Long sentence (${n} words).`, fix: 'Try splitting it in two; aim for under 30 words.' });
      }
      if (/\b(is|are|was|were|be|been|being)\s+(\w+ly\s+)?\w+(ed|en)\b/i.test(s)) passive++;
      const rep = s.match(/\b(\w+)\s+\1\b/i);
      if (rep && !/^(that|had|is)$/i.test(rep[1])) add({ category: 'style', severity: 'warn', block: b.index, quote: rep[0], message: `Repeated word “${rep[0]}”.` });
    }
  }
  if (totalSents >= 10 && passive / totalSents > 0.4)
    add({ category: 'style', severity: 'tip', message: `${Math.round((passive / totalSents) * 100)}% of sentences are in the passive voice.`, fix: academic ? 'Some passive voice is normal in methods; elsewhere, active voice (“We measured…”) reads more clearly.' : 'Prefer active voice where you can.' });

  // ---- Style
  const vagueHits = new Map<string, number>();
  for (const v of VAGUE) {
    const n = (allText.match(new RegExp(`\\b${v}\\b`, 'gi')) ?? []).length;
    if (n) vagueHits.set(v, n);
  }
  const vagueTotal = [...vagueHits.values()].reduce((a, b) => a + b, 0);
  if (vagueTotal >= 3 || (academic && vagueTotal >= 1))
    add({ category: 'style', severity: 'tip', message: `Vague or informal words: ${[...vagueHits].map(([w, n]) => `${w} ×${n}`).join(', ')}.`, fix: 'Replace them with precise, measurable wording.' });
  if (academic && /\b(don't|can't|won't|isn't|it's|we're|they're|doesn't|didn't)\b/i.test(allText))
    add({ category: 'style', severity: 'tip', message: 'Contractions (don’t, it’s…) in a formal document.', fix: 'Write them out in full for academic style.' });
  const mixed = US_UK.filter(([any, uk]) => any.test(allText) && uk.test(allText) && (allText.match(new RegExp(any.source, 'gi')) ?? []).some((m) => !uk.test(m)));
  if (mixed.length) add({ category: 'style', severity: 'tip', message: `Mixed US and UK spelling: ${mixed.map((m) => m[2]).join(', ')}.`, fix: 'Pick one variety and use it throughout.' });

  // ---- Next steps
  if (opts.targetWords && totalWords < opts.targetWords * 0.9)
    add({ category: 'next', severity: 'tip', message: `${totalWords} of ${opts.targetWords} target words (${Math.round((totalWords / opts.targetWords) * 100)}%).`, fix: weakestSection(secs) });
  if (academic && totalWords > 1500 && !bl.some((b) => b.type === 'figure' || b.type === 'table'))
    add({ category: 'next', severity: 'tip', message: 'Consider adding a figure or table.', fix: 'A diagram of your method or a results table helps readers more than a paragraph of numbers.' });
  const title = bl.find((b) => b.style === 'title' || (b.type === 'heading' && b.level === 1));
  if (title && countWords(title.text) > 20) add({ category: 'formatting', severity: 'tip', block: title.index, message: 'The title is longer than 20 words.', fix: 'Shorter titles are easier to find and cite.' });
  return out;
}

function sectionAdvice(name: string): string {
  const m: Record<string, string> = {
    Abstract: '150–250 words: problem, approach, key result, significance.',
    Introduction: 'Context, the gap in existing work, your aim, and a roadmap of the paper.',
    Method: 'Enough detail that someone could repeat what you did: setup, data, tools, parameters.',
    Results: 'What you found, with figures and tables, without interpretation.',
    Discussion: 'What the results mean, how they compare with prior work, and the limitations.',
    Conclusion: 'The main takeaway in a few sentences, plus future work.',
    References: 'Insert a bibliography block (it updates itself from your citations).',
    'Literature Review': 'Group prior work by theme and point out the gap you address.',
  };
  return m[name] ?? 'Most documents of this type include it.';
}

function weakestSection(secs: { heading: string; body: Block[] }[]): string {
  const scored = secs.filter((s) => !/references|bibliography/i.test(s.heading)).map((s) => ({ s, w: countWords(s.body.map((b) => b.text).join(' ')) }));
  if (!scored.length) return 'Add section headings to see which part needs the most work.';
  scored.sort((a, b) => a.w - b.w);
  return `“${scored[0].s.heading || 'Untitled'}” is the shortest section (${scored[0].w} words); expand it first.`;
}
