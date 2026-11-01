import type { CompletionRequest, DataScope } from "./types.js";

/**
 * Prompt builders for AETHER features. Each declares the scopes it sends, so
 * consent prompts are accurate. Writing tasks are framed as assistance on the
 * user's own text, and keep citations and facts intact rather than inventing them.
 */

const GROUNDED = "Only use information in the provided text. If something is not in the text, say so. Never invent citations, data or quotes.";

export function summarizeTask(text: string, scope: DataScope, opts: { length?: "brief" | "detailed"; audience?: string } = {}): CompletionRequest {
  return {
    purpose: "Summarise",
    scopes: [scope],
    system: `You summarise technical material for an engineer${opts.audience ? ` (${opts.audience})` : ""}. ${GROUNDED}`,
    messages: [{ role: "user", content: `Summarise the following ${opts.length === "detailed" ? "in structured bullet points with key equations and numbers" : "in 3-5 sentences"}.\n\n<text>\n${text}\n</text>` }],
    maxTokens: opts.length === "detailed" ? 2000 : 600,
  };
}

export function explainTask(selection: string, question?: string): CompletionRequest {
  return {
    purpose: "Explain selection",
    scopes: question ? ["selection", "prompt"] : ["selection"],
    system: `You explain engineering and science concepts clearly, using LaTeX ($...$) for maths. Distinguish what the text states from general background knowledge.`,
    messages: [{ role: "user", content: `${question ?? "Explain this clearly, defining any jargon."}\n\n<text>\n${selection}\n</text>` }],
    maxTokens: 1200,
  };
}

export function reviseTask(paragraph: string, goal: "clarity" | "concise" | "formal" | "grammar"): CompletionRequest {
  const goals = {
    clarity: "Improve clarity and flow",
    concise: "Make it more concise without losing content",
    formal: "Use a formal academic register",
    grammar: "Fix grammar, spelling and punctuation only",
  };
  return {
    purpose: `Revise text (${goal})`,
    scopes: ["draft"],
    system: `You are an academic writing editor. ${goals[goal]}. Keep the author's meaning, technical terms, numbers, equations and every citation marker such as [@key] or [3] exactly as written. Return only the revised text.`,
    messages: [{ role: "user", content: paragraph }],
    maxTokens: Math.min(4000, Math.ceil(paragraph.length / 2) + 200),
  };
}

export function outlineTask(topic: string, references: string[]): CompletionRequest {
  return {
    purpose: "Suggest outline",
    scopes: references.length ? ["prompt", "references"] : ["prompt"],
    system: "You help structure engineering papers. Propose section headings with one-line descriptions of what each should argue. Suggest where each listed reference could support the argument, by its key. Do not add references that are not listed.",
    messages: [{ role: "user", content: `Topic: ${topic}\n\nReferences available:\n${references.join("\n") || "(none)"}` }],
    maxTokens: 1500,
  };
}

/** Ask for claims in a draft that need a source; returns a JSON array the editor can show inline. */
export function claimCheckTask(draft: string): CompletionRequest {
  return {
    purpose: "Find claims needing citations",
    scopes: ["draft"],
    system: 'You review engineering writing for unsupported claims. Return only JSON: an array of {"quote": exact sentence from the text, "reason": why it needs a source}. Include factual claims, statistics and comparisons that have no citation marker. Return [] if none.',
    messages: [{ role: "user", content: draft }],
    maxTokens: 2000,
  };
}

export function parseClaimCheck(text: string): Array<{ quote: string; reason: string }> {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is { quote: string; reason: string } => typeof x?.quote === "string" && typeof x?.reason === "string") : [];
  } catch {
    return [];
  }
}
