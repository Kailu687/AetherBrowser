import type { Entity, Id } from "@aether/research-core";

export interface Note extends Entity {
  title: string;
  /** Markdown with $inline$ / $$display$$ LaTeX, [[wiki links]], #tags and [@citekey] citations. */
  body: string;
  tags: string[];
  /** Research workspace this note belongs to; notes survive workspace switches because they live in profile storage, not in tabs. */
  workspaceId?: Id;
  profileId?: Id;
  /** Pages this note was captured from. */
  sources: Array<{ url: string; title?: string; capturedAt: string }>;
  pinned?: boolean;
  archived?: boolean;
}

export interface ParsedNote {
  tags: string[];
  wikiLinks: string[];
  citations: Array<{ key: string; locator?: string }>;
  tasks: Array<{ text: string; done: boolean; line: number }>;
  headings: Array<{ level: number; text: string; line: number }>;
  wordCount: number;
}

/** Remove fenced code, inline code and math so tag/link extraction ignores them. */
function stripCode(src: string): string {
  return src
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$/gm, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\$\$[\s\S]*?\$\$/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length))
    .replace(/(?<![\\$])\$(?!\s)[^$\n]+?(?<!\s)\$/g, (m) => " ".repeat(m.length));
}

export function parseNote(body: string): ParsedNote {
  const clean = stripCode(body);
  const tags = new Set<string>();
  for (const m of clean.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) {
    if (!/^\d+$/.test(m[1]!)) tags.add(m[1]!.toLowerCase());
  }
  // Headings "# Title" are not tags: the regex above needs no space after '#', so they are skipped.
  const wikiLinks = [...new Set([...clean.matchAll(/\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g)].map((m) => m[1]!.trim()))];
  const citations: ParsedNote["citations"] = [];
  for (const m of clean.matchAll(/\[(-?@[^\]\n]+)\]/g)) {
    for (const part of m[1]!.split(";")) {
      const c = part.trim().match(/^-?@([\w:.#$%&\-+?<>~/]+)(?:\s*,\s*(.+))?$/);
      if (c) citations.push(c[2] ? { key: c[1]!, locator: c[2].trim() } : { key: c[1]! });
    }
  }
  const lines = body.split("\n");
  const tasks: ParsedNote["tasks"] = [];
  const headings: ParsedNote["headings"] = [];
  const cleanLines = clean.split("\n");
  cleanLines.forEach((l, i) => {
    const t = l.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (t) tasks.push({ text: lines[i]!.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, ""), done: t[1] !== " ", line: i });
    const h = l.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (h) headings.push({ level: h[1]!.length, text: h[2]!, line: i });
  });
  const words = clean.replace(/[#*_>`[\]()-]/g, " ").match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu);
  return { tags: [...tags], wikiLinks, citations, tasks, headings, wordCount: words?.length ?? 0 };
}

/** First heading, else first non-empty line, trimmed to 80 chars. */
export function deriveTitle(body: string): string {
  const h = body.match(/^#{1,6}\s+(.+)$/m);
  const line = h?.[1] ?? body.split("\n").find((l) => l.trim())?.trim() ?? "Untitled";
  const t = line.replace(/[*_`#[\]]/g, "").trim();
  return t.length > 80 ? `${t.slice(0, 77)}…` : t || "Untitled";
}

/** Toggle the checkbox of the task on `line`. */
export function toggleTask(body: string, line: number): string {
  const lines = body.split("\n");
  const l = lines[line];
  if (l === undefined) return body;
  lines[line] = l.replace(/^(\s*[-*+]\s+\[)([ xX])(\])/, (_, a, c, b) => `${a}${c === " " ? "x" : " "}${b}`);
  return lines.join("\n");
}
