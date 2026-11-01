import { parseNote } from "@aether/notebook";
import { validateReference, type Reference } from "@aether/citations";
import type { AiContribution, Paper, Section } from "./model.js";

export interface Issue {
  severity: "error" | "warning" | "info";
  sectionId?: string;
  code:
    | "unresolved-citation"
    | "uncited-reference"
    | "no-citations"
    | "unsupported-claim"
    | "word-count"
    | "empty-section"
    | "long-sentence"
    | "reference-incomplete"
    | "repeated-word"
    | "citation-in-abstract";
  message: string;
  /** Text the issue refers to, for highlighting. */
  excerpt?: string;
}

const stripMarkup = (s: string) =>
  s
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]+\$/g, " X ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>|]/g, " ");

export function sentences(text: string): string[] {
  // Avoid splitting on "e.g.", "et al.", "Fig.", "Eq.", decimals and initials.
  const protectedText = stripMarkup(text).replace(/\b(e\.g|i\.e|et al|Fig|Figs|Eq|Eqs|Ref|Refs|vs|approx|No|Vol|pp|cf|Dr|Prof|Sec)\./g, "$1\u0000").replace(/(\d)\.(\d)/g, "$1\u0000$2").replace(/\b([A-Z])\./g, "$1\u0000");
  return protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"(\[])/)
    .map((x) => x.replace(/\u0000/g, ".").replace(/\s+/g, " ").trim())
    .filter((x) => x.length > 1);
}

export const wordCount = (text: string) => (stripMarkup(text).match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) ?? []).length;

/** Syllable estimate for English readability scores. */
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const m = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, m?.length ?? 1);
}

export interface Readability {
  words: number;
  sentences: number;
  avgSentenceLength: number;
  /** Flesch Reading Ease: 30–50 is typical for academic engineering prose. */
  fleschReadingEase: number;
  /** Share of sentences with a likely passive construction (0–1). */
  passiveRatio: number;
}

export function readability(text: string): Readability {
  const sents = sentences(text);
  const words = stripMarkup(text).match(/[A-Za-z]+/g) ?? [];
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  const nS = Math.max(1, sents.length);
  const nW = Math.max(1, words.length);
  const passive = sents.filter((x) => /\b(?:is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en|wn|lt|ught)\b/i.test(x)).length;
  return {
    words: words.length,
    sentences: sents.length,
    avgSentenceLength: words.length / nS,
    fleschReadingEase: 206.835 - 1.015 * (nW / nS) - 84.6 * (syl / nW),
    passiveRatio: sents.length ? passive / sents.length : 0,
  };
}

/** Phrases that usually signal a factual claim needing a source. */
const CLAIM_PATTERNS: Array<[RegExp, string]> = [
  [/\b(?:studies|research|literature|experts|researchers)\s+(?:show|shows|suggest|suggests|indicate|indicates|have shown|found)\b/i, "Refers to prior research"],
  [/\b(?:it is (?:well[- ])?known|widely (?:used|accepted|adopted)|commonly (?:used|accepted)|state[- ]of[- ]the[- ]art)\b/i, "Appeals to common knowledge"],
  [/\b\d+(?:\.\d+)?\s?%/, "States a percentage"],
  [/\b(?:has|have) (?:been )?(?:increased|decreased|grown|risen|fallen) (?:by|to)\b/i, "States a trend"],
  [/\b(?:first|best|fastest|most (?:efficient|accurate|popular)|largest|leading)\b/i, "Superlative or priority claim"],
  [/\b(?:in|since|by) (?:19|20)\d\d\b/, "Dated historical fact"],
];

const hasCitation = (s: string) => /\[-?@[\w:.#$%&\-+?<>~/]+|\[\d+(?:[,\u2013-]\s*\d+)*\]|\\cite\{/.test(s);

/**
 * Offline checks that help produce defensible writing: every citation
 * resolves, every listed reference is used, claims carry sources, sections
 * meet their targets, references are complete. These are hints, not proof of quality.
 */
export function checkPaper(paper: Paper, library: Map<string, Reference>): Issue[] {
  const issues: Issue[] = [];
  const cited = new Set<string>();

  for (const sec of paper.sections) {
    const text = sec.body.trim();
    if (!text) {
      if (sec.kind !== "acknowledgements") issues.push({ severity: "info", sectionId: sec.id, code: "empty-section", message: `\u201C${sec.heading}\u201D is empty.` });
      continue;
    }
    const keys = parseNote(text).citations.map((c) => c.key);
    keys.forEach((k) => cited.add(k));
    for (const k of new Set(keys)) {
      if (!library.has(k)) issues.push({ severity: "error", sectionId: sec.id, code: "unresolved-citation", message: `Citation @${k} is not in your reference library.`, excerpt: `@${k}` });
    }
    if (sec.kind === "abstract" && keys.length) issues.push({ severity: "warning", sectionId: sec.id, code: "citation-in-abstract", message: "Abstracts normally don't contain citations." });
    if (sec.expectsCitations && !keys.length) issues.push({ severity: "warning", sectionId: sec.id, code: "no-citations", message: `\u201C${sec.heading}\u201D usually cites prior work but has no citations.` });

    const words = wordCount(text);
    if (sec.targetWords) {
      const [lo, hi] = sec.targetWords;
      if (words < lo || words > hi) issues.push({ severity: "info", sectionId: sec.id, code: "word-count", message: `\u201C${sec.heading}\u201D has ${words} words; target is ${lo}\u2013${hi}.` });
    }

    if (sec.kind === "body" || sec.kind === undefined) {
      for (const s of sentences(text)) {
        const raw = s;
        if (!hasCitation(raw)) {
          const hit = CLAIM_PATTERNS.find(([re]) => re.test(raw));
          // Results/method sections report the author's own numbers; only flag patterns about others there.
          const ownWork = /result|experiment|observation|calculation|method|procedure|testing/i.test(sec.heading);
          if (hit && !(ownWork && hit[1] !== "Refers to prior research" && hit[1] !== "Appeals to common knowledge")) {
            issues.push({ severity: "warning", sectionId: sec.id, code: "unsupported-claim", message: `${hit[1]} without a citation.`, excerpt: raw.slice(0, 160) });
          }
        }
        const sw = wordCount(raw);
        if (sw > 45) issues.push({ severity: "info", sectionId: sec.id, code: "long-sentence", message: `Sentence of ${sw} words; consider splitting.`, excerpt: raw.slice(0, 120) });
      }
      const rep = text.match(/\b(\w{2,})\s+\1\b/i);
      if (rep) issues.push({ severity: "warning", sectionId: sec.id, code: "repeated-word", message: `Repeated word \u201C${rep[1]}\u201D.`, excerpt: rep[0] });
    }
  }

  for (const id of paper.referenceIds) {
    if (!cited.has(id)) issues.push({ severity: "info", code: "uncited-reference", message: `Reference @${id} is in the bibliography but never cited.` });
  }
  for (const id of cited) {
    const ref = library.get(id);
    if (!ref) continue;
    for (const v of validateReference(ref)) {
      issues.push({ severity: v.severity === "error" ? "error" : "warning", code: "reference-incomplete", message: `@${id}: ${v.message}` });
    }
  }
  return issues;
}

/** Draft an AI-use disclosure from the paper's log, for the writer to edit and include. */
export function aiDisclosure(paper: Pick<Paper, "aiLog" | "sections">): string {
  const accepted = paper.aiLog.filter((c) => c.accepted);
  if (!accepted.length) return "No generative AI tools were used in preparing this manuscript.";
  const byAction = new Map<string, Set<string>>();
  const models = new Set<string>();
  for (const c of accepted) {
    const heading = paper.sections.find((s) => s.id === c.sectionId)?.heading ?? "a removed section";
    if (!byAction.has(c.action)) byAction.set(c.action, new Set());
    byAction.get(c.action)!.add(heading);
    models.add(c.model);
  }
  const parts = [...byAction].map(([action, secs]) => `${action.toLowerCase()} in ${[...secs].join(", ")}`);
  return `The author(s) used ${[...models].join(", ")} via AETHER for ${parts.join("; ")}. All AI suggestions were reviewed and edited by the author(s), who take full responsibility for the content.`;
}

export function aiSummary(log: AiContribution[]) {
  const accepted = log.filter((c) => c.accepted);
  return { suggestions: log.length, accepted: accepted.length, charsChanged: accepted.reduce((n, c) => n + Math.abs(c.charsAfter - c.charsBefore), 0) };
}

export function sectionStats(sec: Section) {
  return { ...readability(sec.body), words: wordCount(sec.body) };
}
