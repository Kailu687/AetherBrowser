import type { Reference } from "@aether/citations";
import type { Evidence, ExtractionItem } from "./model.js";
import { citedKeys } from "./quality.js";
import { containsQuote, normalize, sentences, tokens } from "./text.js";

/**
 * Citation checks for the Writer's Writing Intelligence panel.
 *
 * For each sentence that cites [@key], compare the sentence with what AETHER
 * holds locally about that source: its abstract, accepted extractions,
 * linked evidence and saved-page text. This is a lexical aid that points the
 * writer at citations worth re-reading; it cannot prove that a source
 * supports a claim, and it says so in every result.
 */

export type SupportVerdict =
  /** A piece of linked evidence from this source closely matches the sentence. */
  | "evidence-linked"
  /** The sentence shares key terms with the source material. */
  | "overlap"
  /** Little in common with what AETHER has of the source: re-read it. */
  | "weak"
  /** Numbers in the sentence do not appear in the source material. */
  | "numbers-missing"
  /** AETHER has no text for this source (no abstract, notes or saved page). */
  | "no-material"
  /** The key is not in the library. */
  | "unknown-key";

export interface CitationCheck {
  sentence: string;
  key: string;
  verdict: SupportVerdict;
  /** Share of the sentence's key terms found in the source material, 0–1. */
  overlap: number;
  /** Best-matching passage from the source material, for the writer to compare. */
  passage?: string;
  /** Where the passage came from. */
  passageFrom?: "abstract" | "extraction" | "evidence" | "saved-page";
  missingNumbers?: string[];
  message: string;
}

export interface CitationReport {
  checks: CitationCheck[];
  /** Keys cited in the text but missing from the library. */
  unknownKeys: string[];
  /** Library references attached to the document but never cited. */
  neverCited: string[];
  /** Sentences that state a number or comparison without any citation. */
  uncitedClaims: string[];
  limits: string[];
}

export const SUPPORT_LIMITS = [
  "This is a word-overlap check against the text AETHER holds for each source (abstract, your extractions, linked evidence, saved pages). It cannot confirm that a source supports a claim: read the cited passage.",
  "A low score often just means AETHER has little text for that source. Save the paper's page or add extractions to improve the check.",
];

export interface SourceMaterial {
  abstract?: string;
  extractions: ExtractionItem[];
  evidence: Evidence[];
  savedText?: string;
}

const NUMBER = /(?<![\w.])(\d+(?:[.,]\d+)?)\s?(%|percent|x|×|db|db?m|hz|khz|mhz|ghz|v|mv|µv|uv|a|ma|µa|w|mw|µw|nm|mm|cm|m|s|ms|µs|ns|k|years?)?(?![\w])/gi;
const CLAIM_CUE = /(\d+(\.\d+)?\s?%|\b(?:outperform|better than|faster than|more (accurate|efficient)|less than|increase[sd]?|decrease[sd]?|reduce[sd]?|significant(ly)?|state[- ]of[- ]the[- ]art|most|first to|widely|commonly|studies (show|have shown)|it is (known|well known))\b)/i;

function numbersIn(s: string): string[] {
  return [...s.matchAll(NUMBER)].map((m) => m[1]!.replace(",", ".")).filter((n) => !/^(19|20)\d\d$/.test(n) && n !== "1" && n !== "2");
}

function stripCitations(s: string): string {
  return s.replace(/\[[^\]]*@[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
}

function passages(m: SourceMaterial): Array<{ text: string; from: CitationCheck["passageFrom"]; evidence?: Evidence }> {
  const out: Array<{ text: string; from: CitationCheck["passageFrom"]; evidence?: Evidence }> = [];
  for (const s of sentences(m.abstract ?? "")) out.push({ text: s, from: "abstract" });
  for (const e of m.extractions) out.push({ text: `${e.text} ${e.quote ?? ""}`.trim(), from: "extraction" });
  for (const e of m.evidence) out.push({ text: `${e.claim} ${e.quote ?? ""}`.trim(), from: "evidence", evidence: e });
  for (const s of sentences((m.savedText ?? "").slice(0, 300_000)).slice(0, 4000)) out.push({ text: s, from: "saved-page" });
  return out;
}

export function checkCitations(markdown: string, refs: Map<string, Reference>, material: (key: string) => SourceMaterial, opts: { attachedIds?: string[] } = {}): CitationReport {
  const text = markdown.replace(/```[\s\S]*?```/g, " ").replace(/\$\$[\s\S]*?\$\$/g, " ");
  const checks: CitationCheck[] = [];
  const uncitedClaims: string[] = [];
  const unknown = new Set<string>();
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/^#+\s.*$/gm, "").replace(/^\s*[-*>]\s+/gm, "").trim()).filter(Boolean);
  for (const para of paragraphs) {
    for (const sent of sentences(para)) {
      const keys = citedKeys(sent);
      const plain = stripCitations(sent);
      if (!keys.length) {
        if (CLAIM_CUE.test(plain) && plain.length > 30) uncitedClaims.push(plain.slice(0, 400));
        continue;
      }
      const terms = new Set(tokens(plain, { stop: true }));
      const nums = numbersIn(plain);
      for (const key of keys) {
        if (!refs.has(key)) {
          unknown.add(key);
          checks.push({ sentence: plain, key, verdict: "unknown-key", overlap: 0, message: `[@${key}] is not in the library.` });
          continue;
        }
        const m = material(key);
        const ps = passages(m);
        if (!ps.length) {
          checks.push({ sentence: plain, key, verdict: "no-material", overlap: 0, message: "AETHER has no text for this source yet (no abstract, extractions, evidence or saved page), so it cannot compare." });
          continue;
        }
        let best = { score: 0, p: ps[0]! };
        for (const p of ps) {
          const pt = new Set(tokens(p.text, { stop: true }));
          let hit = 0;
          for (const t of terms) if (pt.has(t)) hit++;
          const score = terms.size ? hit / terms.size : 0;
          if (score > best.score) best = { score, p };
        }
        const all = normalize(ps.map((p) => p.text).join(" "));
        const missing = nums.filter((n) => !all.includes(normalize(n)));
        const overlap = Math.round(best.score * 100) / 100;
        let verdict: SupportVerdict;
        let message: string;
        if (best.p.from === "evidence" && best.score >= 0.5) {
          verdict = "evidence-linked";
          message = "Matches evidence you linked from this source.";
        } else if (missing.length && missing.length === nums.length) {
          verdict = "numbers-missing";
          message = `The number${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "do" : "does"} not appear in what AETHER has of this source. Check the figure against the paper.`;
        } else if (best.score >= 0.35) {
          verdict = "overlap";
          message = "Shares key terms with the source material. Still confirm the source says this.";
        } else {
          verdict = "weak";
          message = "Little in common with what AETHER has of this source. Re-read the source, or check that this is the right citation.";
        }
        checks.push({ sentence: plain, key, verdict, overlap, passage: best.p.text.slice(0, 500), passageFrom: best.p.from, missingNumbers: missing.length ? missing : undefined, message });
      }
    }
  }
  const cited = new Set(citedKeys(text));
  const neverCited = (opts.attachedIds ?? []).filter((id) => !cited.has(id));
  return { checks, unknownKeys: [...unknown], neverCited, uncitedClaims: uncitedClaims.slice(0, 200), limits: SUPPORT_LIMITS };
}

/** Optional AI second opinion on one citation. The model must quote the material; unquoted answers are discarded. */
export function supportPrompt(sentence: string, material: string): { system: string; prompt: string } {
  return {
    system:
      'You check whether a cited source supports a sentence, using ONLY the source material given. Return ONLY JSON: {"verdict": "supports" | "partly" | "does-not-support" | "cannot-tell", "quote": an exact passage copied from the material that your verdict rests on, or "" if none, "reason": one sentence}. Never use outside knowledge.',
    prompt: `Sentence: ${sentence}\n\n<material>\n${material.slice(0, 60_000)}\n</material>`,
  };
}

export function parseSupport(raw: string, material: string): { verdict: "supports" | "partly" | "does-not-support" | "cannot-tell"; quote?: string; reason: string } | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    type V = "supports" | "partly" | "does-not-support" | "cannot-tell";
    const verdict: V = ["supports", "partly", "does-not-support", "cannot-tell"].includes(o.verdict as string) ? (o.verdict as V) : "cannot-tell";
    const quote = typeof o.quote === "string" ? o.quote.trim() : "";
    const reason = typeof o.reason === "string" ? o.reason.slice(0, 500) : "";
    // A "supports"/"partly" verdict without a real quote from the material is not trusted.
    if ((verdict === "supports" || verdict === "partly") && !containsQuote(material, quote)) return { verdict: "cannot-tell", reason: "The model's answer did not quote the source material, so it was not used." };
    return { verdict, quote: quote || undefined, reason };
  } catch {
    return null;
  }
}
