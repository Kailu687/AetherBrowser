/** Text helpers shared by discovery, verification, extraction and gap analysis. Pure functions, no I/O. */

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Key used to merge works without identifiers: normalised title + year. */
export function titleKey(title: string | undefined, year?: number | string): string {
  return `t:${normalize(title ?? "").replace(/ /g, "")}:${year ?? ""}`;
}

const STOP = new Set(
  "a an and are as at be by for from has have in into is it its of on or that the their this to was were which with we our using use based via than then these those such not can may also between within under over new study paper approach method results".split(" "),
);

export function tokens(s: string, opts: { stop?: boolean } = {}): string[] {
  const t = normalize(s).split(" ").filter(Boolean);
  return opts.stop ? t.filter((w) => w.length > 2 && !STOP.has(w)) : t;
}

/** Levenshtein distance with an early cap (inputs are short: titles, names). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Title similarity in [0, 1]: the better of a character-level ratio and token
 * overlap, so "Deep Residual Learning for Image Recognition" matches
 * "Deep residual learning for image recognition." but not "Deep learning".
 */
export function titleSimilarity(a: string | undefined, b: string | undefined): number {
  const na = normalize(a ?? "");
  const nb = normalize(b ?? "");
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const long = Math.max(na.length, nb.length);
  const charRatio = long > 400 ? 0 : 1 - levenshtein(na, nb) / long;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const jaccard = inter / (ta.size + tb.size - inter);
  return Math.max(charRatio, jaccard);
}

/** Split prose into sentences, keeping common abbreviations ("et al.", "e.g.", "Fig. 3") intact. */
export function sentences(text: string): string[] {
  const protectedText = text
    .replace(/\s+/g, " ")
    .replace(/\b(et al|e\.g|i\.e|etc|Fig|Figs|Eq|Eqs|Ref|Refs|No|vs|cf|approx|resp|Sec|Tab)\./gi, (m) => m.replace(/\./g, "\u0000"));
  return protectedText
    .split(/(?<=[.!?])\s+(?=[A-Z0-9(“"'])/)
    .map((s) => s.replace(/\u0000/g, ".").trim())
    .filter((s) => s.length > 0);
}

/** Whitespace- and case-insensitive containment, used to check that quotes really occur in a source. */
export function containsQuote(haystack: string, quote: string): boolean {
  const norm = (s: string) => s.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
  const q = norm(quote);
  return q.length >= 12 && norm(haystack).includes(q);
}

/** Remove markup and control characters from text received from the network; cap the length. */
export function cleanText(s: unknown, max = 20_000): string | undefined {
  if (typeof s !== "string") return undefined;
  const out = s
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return out ? out.slice(0, max) : undefined;
}

/** Only http(s) links ever leave the module for the UI (no javascript:, data:, file:). */
export function safeUrl(u: unknown): string | undefined {
  if (typeof u !== "string" || u.length > 4000) return undefined;
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** CSV cell with protection against formula injection in spreadsheet apps. */
export function csvCell(v: string): string {
  let s = v ?? "";
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Escape a Markdown table cell. */
export function mdCell(s: string): string {
  return (s ?? "").replace(/\|/g, "\\|").replace(/\s*\r?\n\s*/g, " ");
}
