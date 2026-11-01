import type { Note } from "./model.js";

/** Export a note as Markdown with YAML front matter (Obsidian/Zettlr/pandoc compatible). */
export function noteToMarkdown(note: Note): string {
  const yaml = [
    "---",
    `title: ${JSON.stringify(note.title)}`,
    `created: ${note.createdAt}`,
    `updated: ${note.updatedAt}`,
    note.tags.length ? `tags: [${note.tags.map((t) => JSON.stringify(t)).join(", ")}]` : undefined,
    note.sources.length ? `sources:\n${note.sources.map((s) => `  - ${JSON.stringify(s.url)}`).join("\n")}` : undefined,
    "---",
  ].filter(Boolean);
  return `${yaml.join("\n")}\n\n${note.body.trimEnd()}\n`;
}

/** Parse front matter written by noteToMarkdown (and simple hand-written YAML). */
export function markdownToNoteInput(src: string): { title?: string; body: string; sources: string[] } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: src, sources: [] };
  const fm = m[1]!;
  const titleRaw = fm.match(/^title:\s*(.+)$/m)?.[1]?.trim();
  let title: string | undefined;
  if (titleRaw) {
    try {
      title = titleRaw.startsWith('"') ? JSON.parse(titleRaw) : titleRaw;
    } catch {
      title = titleRaw;
    }
  }
  const sources = [...fm.matchAll(/^\s+-\s+"?([^"\n]+)"?$/gm)].map((x) => x[1]!).filter((u) => /^https?:/.test(u));
  return { title, body: src.slice(m[0].length).replace(/^\r?\n/, ""), sources };
}

/** Safe filename for exporting notes to disk. */
export function noteFileName(note: Pick<Note, "title">): string {
  const base = note.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 100) || "Untitled";
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base) ? `${base}_.md` : `${base}.md`;
}
