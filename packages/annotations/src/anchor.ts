/** W3C Web Annotation selectors (https://www.w3.org/TR/annotation-model/#selectors). */
export interface TextQuoteSelector {
  type: "TextQuoteSelector";
  exact: string;
  prefix?: string;
  suffix?: string;
}
export interface TextPositionSelector {
  type: "TextPositionSelector";
  start: number;
  end: number;
}
/** PDF page, 1-based. AETHER-specific but serialises as a FragmentSelector "page=N". */
export interface PageSelector {
  type: "PageSelector";
  page: number;
}
export type Selector = TextQuoteSelector | TextPositionSelector | PageSelector;

const CONTEXT = 32;

/** Build quote + position selectors for text[start, end). */
export function describeRange(text: string, start: number, end: number): [TextQuoteSelector, TextPositionSelector] {
  if (start < 0 || end > text.length || start >= end) throw new RangeError("Invalid range");
  return [
    { type: "TextQuoteSelector", exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT) },
    { type: "TextPositionSelector", start, end },
  ];
}

export interface AnchorResult {
  start: number;
  end: number;
  /** "exact" = position still matches, "quote" = re-found by quote+context, "fuzzy" = whitespace-insensitive match. */
  method: "position" | "quote" | "fuzzy";
}

/** Count matching chars at the end of a / start of b, for context scoring. */
function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Re-locate a highlight in (possibly changed) text. Tries the stored
 * position first, then every occurrence of the quote ranked by how well the
 * surrounding context matches and how close it is to the old position, then
 * a whitespace-insensitive search. Returns null when the passage is gone.
 */
export function anchor(text: string, quote: TextQuoteSelector, position?: TextPositionSelector): AnchorResult | null {
  const { exact } = quote;
  if (!exact) return null;
  if (position && text.slice(position.start, position.end) === exact) {
    return { start: position.start, end: position.end, method: "position" };
  }
  const candidates: number[] = [];
  for (let i = text.indexOf(exact); i !== -1; i = text.indexOf(exact, i + 1)) candidates.push(i);
  if (candidates.length) {
    let best = candidates[0]!;
    let bestScore = -Infinity;
    for (const i of candidates) {
      const pre = quote.prefix ? commonSuffix(text.slice(Math.max(0, i - quote.prefix.length), i), quote.prefix) : 0;
      const suf = quote.suffix ? commonPrefix(text.slice(i + exact.length, i + exact.length + quote.suffix.length), quote.suffix) : 0;
      const dist = position ? Math.abs(i - position.start) / Math.max(text.length, 1) : 0;
      const score = pre + suf - dist * 10;
      if (score > bestScore) (bestScore = score), (best = i);
    }
    return { start: best, end: best + exact.length, method: "quote" };
  }
  // Fuzzy: collapse whitespace on both sides and map back to original offsets.
  const { norm, map } = normalizeWithMap(text);
  const needle = exact.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  const at = norm.indexOf(needle);
  if (at === -1) return null;
  return { start: map[at]!, end: map[at + needle.length - 1]! + 1, method: "fuzzy" };
}

function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let prevSpace = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/.test(c)) {
      if (!prevSpace) {
        norm += " ";
        map.push(i);
      }
      prevSpace = true;
    } else {
      norm += c;
      map.push(i);
      prevSpace = false;
    }
  }
  return { norm, map };
}
