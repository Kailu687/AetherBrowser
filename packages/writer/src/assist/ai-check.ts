import { countWords, sentences, WORD_RE } from '../doc.js';

/**
 * A transparent, offline estimate of how "machine-like" a passage reads.
 *
 * This is a stylometric indicator, not a detector: no tool can tell reliably
 * whether text was written by AI, and all of them misfire on formal writing
 * and on non-native English. AETHER shows the evidence behind the number so a
 * writer or reviewer can judge it, and never offers to "humanise" text.
 */
export interface AiCheckSignal {
  id: string;
  label: string;
  /** 0 (human-typical) .. 1 (machine-typical). */
  score: number;
  detail: string;
}

export interface AiCheckResult {
  /** 0..100, or null if the text is too short to say anything. */
  score: number | null;
  band: 'too-short' | 'low' | 'mixed' | 'high';
  words: number;
  signals: AiCheckSignal[];
  /** Sentences with stock phrasing, for highlighting. */
  flagged: { sentence: string; phrases: string[] }[];
  disclaimer: string;
}

/** Phrases that are heavily over-represented in chatbot output. */
export const STOCK_PHRASES = [
  'delve', 'delves', 'delving', 'tapestry', 'in today\'s fast-paced', 'in the ever-evolving', 'ever-changing landscape', 'it is important to note',
  'it is worth noting', 'plays a crucial role', 'plays a pivotal role', 'a testament to', 'navigate the complexities', 'in the realm of',
  'unlock the potential', 'harness the power', 'seamlessly', 'seamless integration', 'multifaceted', 'underscores the importance',
  'shed light on', 'paving the way', 'game-changer', 'cutting-edge', 'robust framework', 'holistic approach', 'foster', 'leveraging',
  'in conclusion,', 'overall,', 'furthermore,', 'moreover,', 'additionally,', 'notably,', 'ultimately,', 'embark on', 'intricate',
  'meticulous', 'meticulously', 'showcasing', 'nuanced', 'an indispensable', 'stands as', 'not only', 'serves as a',
];

const clamp = (x: number) => Math.max(0, Math.min(1, x));

function stdev(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

export function aiCheck(text: string): AiCheckResult {
  const disclaimer =
    'This is a writing-style indicator, not proof of authorship. AI detectors (including this one) are often wrong, especially on formal, technical or non-native English. Never use it alone to accuse anyone.';
  const words = countWords(text);
  const sents = sentences(text);
  if (words < 80 || sents.length < 4) return { score: null, band: 'too-short', words, signals: [], flagged: [], disclaimer };

  const lower = text.toLowerCase();
  const signals: AiCheckSignal[] = [];

  // 1. Burstiness: humans vary sentence length a lot; models are steadier.
  const lens = sents.map((s) => countWords(s)).filter((n) => n > 0);
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  const cv = stdev(lens) / (mean || 1);
  signals.push({ id: 'burstiness', label: 'Sentence-length variation', score: clamp((0.55 - cv) / 0.35), detail: `Coefficient of variation ${cv.toFixed(2)} (human prose is usually above 0.5).` });

  // 2. Stock phrasing density.
  const flagged: AiCheckResult['flagged'] = [];
  let hits = 0;
  for (const s of sents) {
    const sl = s.toLowerCase();
    const found = STOCK_PHRASES.filter((p) => (p.endsWith(',') ? sl.startsWith(p) || sl.includes(` ${p}`) : new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\']/g, '\\$&')}\\b`).test(sl)));
    if (found.length) {
      hits += found.length;
      flagged.push({ sentence: s, phrases: found });
    }
  }
  const per1k = (hits / words) * 1000;
  signals.push({ id: 'phrases', label: 'Stock phrasing', score: clamp(per1k / 12), detail: `${hits} stock phrase${hits === 1 ? '' : 's'} (${per1k.toFixed(1)} per 1000 words).` });

  // 3. Lexical diversity (moving-average type-token ratio over 50-word windows).
  const toks = (lower.match(WORD_RE) ?? []) as string[];
  const win = 50;
  let ttrSum = 0;
  let n = 0;
  for (let i = 0; i + win <= toks.length; i += 25) {
    ttrSum += new Set(toks.slice(i, i + win)).size / win;
    n++;
  }
  const mattr = n ? ttrSum / n : new Set(toks).size / toks.length;
  signals.push({ id: 'diversity', label: 'Vocabulary pattern', score: clamp(Math.abs(mattr - 0.74) < 0.04 ? 0.6 : mattr < 0.62 ? 0.5 : 0.2), detail: `Moving type-token ratio ${mattr.toFixed(2)}.` });

  // 4. Repetitive sentence openings.
  const starts = sents.map((s) => (s.match(WORD_RE) ?? [''])[0]!.toLowerCase());
  const counts = new Map<string, number>();
  for (const w of starts) counts.set(w, (counts.get(w) ?? 0) + 1);
  const transitions = ['however', 'additionally', 'furthermore', 'moreover', 'overall', 'thus', 'therefore', 'consequently', 'notably'];
  const transitionStarts = starts.filter((w) => transitions.includes(w)).length / starts.length;
  signals.push({ id: 'transitions', label: 'Transition-word openings', score: clamp(transitionStarts / 0.25), detail: `${Math.round(transitionStarts * 100)}% of sentences start with a connective such as “Furthermore”.` });

  // 5. Personal / concrete markers lower the estimate.
  const concrete = (text.match(/\b(I|we|my|our)\b|\d+(\.\d+)?\s?(%|mm|cm|m|kg|V|A|Hz|s|ms|°C|K)\b|\[@|\(\w+,?\s\d{4}\)/g) ?? []).length;
  signals.push({ id: 'specifics', label: 'Specific detail', score: clamp(1 - concrete / (words / 40)), detail: `${concrete} first-person, measured or cited detail${concrete === 1 ? '' : 's'}.` });

  // 6. Uniform paragraphs.
  const paras = text.split(/\n\s*\n|\n/).map((p) => countWords(p)).filter((x) => x > 15);
  const pcv = paras.length > 2 ? stdev(paras) / (paras.reduce((a, b) => a + b, 0) / paras.length) : 0.5;
  signals.push({ id: 'paragraphs', label: 'Paragraph uniformity', score: paras.length > 2 ? clamp((0.35 - pcv) / 0.3) : 0.3, detail: paras.length > 2 ? `Paragraph lengths vary by ${Math.round(pcv * 100)}%.` : 'Too few paragraphs to compare.' });

  const weights: Record<string, number> = { burstiness: 0.27, phrases: 0.3, diversity: 0.08, transitions: 0.12, specifics: 0.15, paragraphs: 0.08 };
  const raw = signals.reduce((acc, s) => acc + s.score * (weights[s.id] ?? 0), 0);
  const score = Math.round(raw * 100);
  return { score, band: score >= 60 ? 'high' : score >= 35 ? 'mixed' : 'low', words, signals, flagged, disclaimer };
}
