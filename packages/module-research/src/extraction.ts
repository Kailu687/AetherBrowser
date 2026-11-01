import { EXTRACTION_FIELDS, type ExtractionField, type ExtractionItem } from "./model.js";
import { containsQuote, sentences } from "./text.js";

/**
 * Extraction of methods, datasets, metrics, findings and limitations.
 *
 * Two suggestion sources, both of which only ever produce *suggestions* the
 * user accepts or rejects:
 *  - a transparent offline heuristic that picks sentences containing cue
 *    phrases ("we propose", "dataset", "a limitation"), and
 *  - an optional AI pass whose every suggestion must quote the source
 *    verbatim. Suggestions whose quote is not found in the text are dropped,
 *    so the model cannot introduce findings that are not in the paper.
 */

export type Suggestion = Pick<ExtractionItem, "field" | "text" | "quote" | "labels" | "origin"> & { cue?: string };

const CUES: Record<ExtractionField, RegExp[]> = {
  objective: [/\b(we|this (paper|study|work|article))\s+(aim|aims|seek|seeks|investigate|investigates|address|addresses|explore|explores|examine|examines|ask|asks)\b/i, /\b(the (aim|goal|objective|purpose) of this)\b/i, /\bresearch question\b/i],
  methods: [/\b(we|this (paper|study|work))\s+(propose|proposes|present|presents|introduce|introduces|develop|develops|design|designs|use|used|employ|employed|apply|applied|train|trained|simulate|simulated|fabricate|fabricated)\b/i, /\b(method|methodology|approach|framework|algorithm|architecture|model|technique|protocol|simulation)\b.*\b(based on|using|consists of|comprises)\b/i, /\b(randomi[sz]ed|cross-sectional|longitudinal|case study|survey|meta-analysis|systematic review)\b/i],
  datasets: [/\b(dataset|data set|corpus|benchmark|cohort|participants|subjects|samples|specimens|testbed)\b/i, /\b(collected|recorded|measured)\b.*\b(data|samples)\b/i, /\bn\s*=\s*\d+/i],
  metrics: [/\b(accuracy|precision|recall|F1|AUC|RMSE|MAE|BLEU|PSNR|SNR|BER|latency|throughput|efficiency|error rate|p\s*[<=]\s*0?\.\d+|confidence interval)\b/i],
  findings: [/\b(results?|experiments?|evaluation|analysis)\s+(show|shows|showed|indicate|indicates|demonstrate|demonstrates|reveal|reveals|suggest|suggests)\b/i, /\b(we|our)\s+(find|found|show|showed|demonstrate|observe|observed|achieve|achieved|outperform|outperforms)\b/i, /\b(outperform|outperforms|improves?|reduces?|increases?)\b.*\b(by|to)\s+\d/i, /\bsignificant(ly)?\b/i],
  limitations: [/\blimitations?\b/i, /\b(however|but),?\s+(our|the|this)\s+(method|approach|study|model)\b/i, /\b(does not|do not|cannot|could not|fails? to|is limited|are limited|only (applies|works|considers))\b/i, /\b(small sample|threats to validity|generali[sz]ab)/i],
  futureWork: [/\bfuture (work|research|studies|directions?)\b/i, /\b(remains?|is|are) (an )?open (question|problem|challenge)s?\b/i, /\b(further|more) (research|work|investigation) is (needed|required)\b/i, /\bwe (plan|intend) to\b/i],
};

/** Offline heuristic suggestions from text the user supplied (abstract, page or PDF text). */
export function heuristicSuggestions(text: string, opts: { maxPerField?: number } = {}): Suggestion[] {
  const max = opts.maxPerField ?? 3;
  const out: Suggestion[] = [];
  const perField = new Map<ExtractionField, number>();
  for (const s of sentences(text.slice(0, 400_000))) {
    if (s.length < 25 || s.length > 600) continue;
    for (const field of EXTRACTION_FIELDS) {
      if ((perField.get(field) ?? 0) >= max) continue;
      const cue = CUES[field].find((re) => re.test(s));
      if (!cue) continue;
      perField.set(field, (perField.get(field) ?? 0) + 1);
      out.push({ field, text: s, quote: s, labels: [], origin: "heuristic", cue: s.match(cue)?.[0] });
      break; // one field per sentence; the user can re-file it
    }
  }
  return out;
}

/** Prompt for the optional AI pass. The model must quote; the response is JSON only. */
export function extractionPrompt(text: string, title?: string): { system: string; prompt: string } {
  return {
    system: [
      "You extract structured information from one research paper for a literature review.",
      "Use ONLY the text provided. Do not add knowledge from elsewhere, do not guess numbers, and do not invent datasets, results or limitations.",
      'Return ONLY a JSON array. Each element: {"field": one of ' + EXTRACTION_FIELDS.map((f) => `"${f}"`).join(", ") + ', "text": a short paraphrase, "quote": an EXACT verbatim sentence or clause copied from the text that supports it, "labels": up to 3 short canonical labels (e.g. method or dataset names that appear in the text)}.',
      "If the text does not state something, leave that field out. Return [] if nothing applies.",
    ].join(" "),
    prompt: `${title ? `Title: ${title}\n\n` : ""}<paper>\n${text.slice(0, 120_000)}\n</paper>`,
  };
}

export interface ParsedAiSuggestions {
  accepted: Suggestion[];
  /** Suggestions dropped because their quote is not in the source text, or they were malformed. */
  rejected: Array<{ reason: string; text?: string }>;
}

/** Parse and validate the AI's JSON. Anything not backed by a verbatim quote is rejected. */
export function parseAiSuggestions(raw: string, sourceText: string): ParsedAiSuggestions {
  const rejected: ParsedAiSuggestions["rejected"] = [];
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return { accepted: [], rejected: [{ reason: "The model did not return a JSON list." }] };
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return { accepted: [], rejected: [{ reason: "The model returned invalid JSON." }] };
  }
  if (!Array.isArray(arr)) return { accepted: [], rejected: [{ reason: "The model did not return a JSON list." }] };
  const accepted: Suggestion[] = [];
  for (const x of arr.slice(0, 100)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    const field = o.field as ExtractionField;
    const text = typeof o.text === "string" ? o.text.trim().slice(0, 2000) : "";
    const quote = typeof o.quote === "string" ? o.quote.trim().slice(0, 2000) : "";
    if (!EXTRACTION_FIELDS.includes(field)) {
      rejected.push({ reason: `Unknown field “${String(o.field).slice(0, 40)}”.`, text });
      continue;
    }
    if (!text) continue;
    if (!quote || !containsQuote(sourceText, quote)) {
      rejected.push({ reason: "Its quote does not appear in the source text, so it was not added.", text });
      continue;
    }
    const labels = Array.isArray(o.labels) ? o.labels.filter((l): l is string => typeof l === "string").map((l) => l.trim().slice(0, 60)).filter(Boolean).slice(0, 3) : [];
    accepted.push({ field, text, quote, labels, origin: "ai" });
  }
  return { accepted, rejected };
}

/** Canonicalise a label for grouping ("Convolutional NN" and "convolutional nn" match). */
export const canonLabel = (l: string) => l.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}+#.]+/gu, " ").trim();
