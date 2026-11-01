import type { Note } from "./model.js";

/** Lower-case, accent-folded word tokens. */
export function tokenize(s: string): string[] {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export interface SearchHit {
  note: Note;
  score: number;
  snippet: string;
}

/**
 * Small in-memory ranked search (title matches weigh most, then tags, then body;
 * prefix matching on the last term so results update as you type).
 * Fine for thousands of notes; the shell can swap in SQLite FTS5 for larger libraries.
 */
export function searchNotes(notes: Note[], query: string, limit = 50): SearchHit[] {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const tagFilter = [...query.matchAll(/#([\p{L}\p{N}_/-]+)/gu)].map((m) => m[1]!.toLowerCase());
  const hits: SearchHit[] = [];
  for (const note of notes) {
    if (tagFilter.length && !tagFilter.every((t) => note.tags.includes(t))) continue;
    const title = tokenize(note.title);
    const body = tokenize(note.body);
    let score = 0;
    let all = true;
    terms.forEach((term, i) => {
      const prefix = i === terms.length - 1;
      const match = (w: string) => (prefix ? w.startsWith(term) : w === term);
      const t = title.filter(match).length;
      const g = note.tags.filter((x) => match(x)).length;
      const b = body.filter(match).length;
      if (!t && !g && !b) all = false;
      score += t * 5 + g * 3 + Math.min(b, 10);
    });
    if (!all) continue;
    if (note.pinned) score += 1;
    hits.push({ note, score, snippet: snippet(note.body, terms) });
  }
  return hits.sort((a, b) => b.score - a.score || b.note.updatedAt.localeCompare(a.note.updatedAt)).slice(0, limit);
}

function snippet(body: string, terms: string[], radius = 60): string {
  const folded = body.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const idx = Math.min(...terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0), Infinity);
  if (!Number.isFinite(idx)) return body.slice(0, radius * 2).replace(/\s+/g, " ").trim();
  const start = Math.max(0, idx - radius);
  return `${start > 0 ? "…" : ""}${body.slice(start, idx + radius).replace(/\s+/g, " ").trim()}${idx + radius < body.length ? "…" : ""}`;
}
