import type { Name } from "./types.js";

const PARTICLES = new Set([
  "van", "von", "der", "den", "de", "del", "della", "di", "da", "du", "la", "le", "dos", "das", "ter", "ten", "bin", "al", "el", "st.",
]);
const SUFFIXES = /^(jr\.?|sr\.?|ii|iii|iv|v)$/i;

/**
 * Parse a personal name written as "Family, Given", "Family, Suffix, Given",
 * or "Given Family". Lower-case particles (van, de, von) stay with the family
 * name. Text wrapped in braces, e.g. "{IEEE Computer Society}", becomes a literal.
 */
export function parseName(raw: string): Name {
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s) return { literal: "" };
  if (/^\{.*\}$/.test(s)) return { literal: s.slice(1, -1) };

  const commaParts = s.split(/\s*,\s*/);
  if (commaParts.length >= 2) {
    const [familyPart, a, b] = commaParts as [string, string, string | undefined];
    const suffix = b !== undefined ? a : undefined;
    const given = b !== undefined ? b : a;
    return withParticle(familyPart, given, suffix);
  }

  const words = s.split(" ");
  if (words.length === 1) return { family: words[0] };
  let suffix: string | undefined;
  if (SUFFIXES.test(words[words.length - 1]!)) suffix = words.pop();
  // Family starts at the first lower-case particle, or is the last word.
  let familyStart = words.length - 1;
  for (let i = 1; i < words.length - 1; i++) {
    if (PARTICLES.has(words[i]!.toLowerCase()) && words[i] === words[i]!.toLowerCase()) {
      familyStart = i;
      break;
    }
  }
  return withParticle(words.slice(familyStart).join(" "), words.slice(0, familyStart).join(" "), suffix);
}

function withParticle(familyPart: string, given: string | undefined, suffix: string | undefined): Name {
  const words = familyPart.split(" ");
  const particle: string[] = [];
  while (words.length > 1 && words[0] === words[0]!.toLowerCase() && PARTICLES.has(words[0]!.toLowerCase())) {
    particle.push(words.shift()!);
  }
  const name: Name = { family: words.join(" ") };
  if (given) name.given = given;
  if (particle.length) name["non-dropping-particle"] = particle.join(" ");
  if (suffix) name.suffix = suffix;
  return name;
}

/** Split a BibTeX-style author list on top-level " and ". */
export function parseNameList(raw: string): Name[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  const tokens = raw.split(/(\{|\}|\s+and\s+)/i);
  for (const t of tokens) {
    if (t === "{") depth++;
    if (t === "}") depth--;
    if (depth === 0 && /^\s+and\s+$/i.test(t)) {
      out.push(cur);
      cur = "";
    } else cur += t;
  }
  out.push(cur);
  return out.map((n) => n.trim()).filter(Boolean).map(parseName);
}

/** Family name including particle: "van Rossum". */
export function familyName(n: Name): string {
  if (n.literal) return n.literal;
  return [n["non-dropping-particle"], n.family].filter(Boolean).join(" ");
}

/** "Guido" → "G."; "Jean-Paul" → "J.-P."; "J. R. R." → "J. R. R." */
export function initials(given: string | undefined, sep = " "): string {
  if (!given) return "";
  return given
    .split(/\s+/)
    .filter(Boolean)
    .map((w) =>
      w
        .split("-")
        .map((p) => {
          const letter = p.replace(/[^\p{L}]/gu, "").charAt(0);
          return letter ? `${letter.toUpperCase()}.` : "";
        })
        .filter(Boolean)
        .join("-"),
    )
    .filter(Boolean)
    .join(sep);
}

/** "Smith, J. A." (APA) */
export function familyInitials(n: Name): string {
  if (n.literal) return n.literal;
  const ini = initials(n.given);
  const base = ini ? `${familyName(n)}, ${ini}` : familyName(n);
  return n.suffix ? `${base}, ${n.suffix}` : base;
}

/** "J. A. Smith" (IEEE) */
export function initialsFamily(n: Name): string {
  if (n.literal) return n.literal;
  const ini = initials(n.given);
  const base = ini ? `${ini} ${familyName(n)}` : familyName(n);
  return n.suffix ? `${base}, ${n.suffix}` : base;
}

/** "Smith, John A." (MLA/Chicago first author) */
export function familyGiven(n: Name): string {
  if (n.literal) return n.literal;
  const base = n.given ? `${familyName(n)}, ${n.given}` : familyName(n);
  return n.suffix ? `${base}, ${n.suffix}` : base;
}

/** "John A. Smith" */
export function givenFamily(n: Name): string {
  if (n.literal) return n.literal;
  const base = [n.given, familyName(n)].filter(Boolean).join(" ");
  return n.suffix ? `${base}, ${n.suffix}` : base;
}

/** Key used for sorting bibliographies: family, given. */
export function sortKey(n: Name | undefined): string {
  if (!n) return "";
  return (n.literal ?? `${n.family ?? ""} ${n.given ?? ""}`).toLocaleLowerCase();
}

/** Join with commas and a final conjunction: "A, B, and C" (serial) or "A and B". */
export function joinList(items: string[], conj: string, serialComma = true): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}${serialComma ? "," : ""} ${conj} ${items[items.length - 1]}`;
}
