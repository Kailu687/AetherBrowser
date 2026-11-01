import { createId, Emitter, systemClock, type Clock, type Collection, type Id } from "@aether/research-core";
import { deriveTitle, parseNote, type Note } from "./model.js";
import { searchNotes } from "./search.js";

export type NoteEvent = { type: "created" | "updated" | "deleted"; id: Id };

export interface NewNote {
  body: string;
  title?: string;
  workspaceId?: Id;
  profileId?: Id;
  source?: { url: string; title?: string };
}

/** Notebook operations over a profile-scoped collection. */
export class Notebook {
  readonly events = new Emitter<NoteEvent>();

  constructor(
    private readonly notes: Collection<Note>,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: NewNote): Promise<Note> {
    const now = this.clock.now().toISOString();
    const note: Note = {
      id: createId("note"),
      createdAt: now,
      updatedAt: now,
      title: input.title?.trim() || deriveTitle(input.body),
      body: input.body,
      tags: parseNote(input.body).tags,
      sources: input.source ? [{ ...input.source, capturedAt: now }] : [],
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.profileId ? { profileId: input.profileId } : {}),
    };
    await this.notes.put(note);
    this.events.emit({ type: "created", id: note.id });
    return note;
  }

  /**
   * Quick capture: save a thought into a workspace without leaving the current
   * page. Appends to that workspace's "Inbox" note for the day so captures stay grouped.
   */
  async capture(text: string, opts: { workspaceId?: Id; profileId?: Id; source?: { url: string; title?: string } } = {}): Promise<Note> {
    const day = this.clock.now().toISOString().slice(0, 10);
    const title = `Inbox ${day}`;
    const existing = (await this.notes.list((n) => n.title === title && n.workspaceId === opts.workspaceId && !n.archived))[0];
    const time = this.clock.now().toISOString().slice(11, 16);
    const line = `- ${time} ${text.trim()}${opts.source ? ` ([${opts.source.title ?? "source"}](${opts.source.url}))` : ""}`;
    if (!existing) return this.create({ ...opts, title, body: `# ${title}\n\n${line}\n` });
    return this.update(existing.id, {
      body: `${existing.body.trimEnd()}\n${line}\n`,
      sources: opts.source ? [...existing.sources, { ...opts.source, capturedAt: this.clock.now().toISOString() }] : existing.sources,
    });
  }

  async get(id: Id): Promise<Note | undefined> {
    return this.notes.get(id);
  }

  async update(id: Id, patch: Partial<Omit<Note, "id" | "createdAt">>): Promise<Note> {
    const cur = await this.notes.get(id);
    if (!cur) throw new Error(`Note ${id} not found`);
    const next: Note = { ...cur, ...patch, id, createdAt: cur.createdAt, updatedAt: this.clock.now().toISOString() };
    if (patch.body !== undefined) {
      next.tags = parseNote(next.body).tags;
      if (patch.title === undefined && cur.title === deriveTitle(cur.body)) next.title = deriveTitle(next.body);
    }
    await this.notes.put(next);
    this.events.emit({ type: "updated", id });
    return next;
  }

  async delete(id: Id): Promise<boolean> {
    const ok = await this.notes.delete(id);
    if (ok) this.events.emit({ type: "deleted", id });
    return ok;
  }

  async list(opts: { workspaceId?: Id | null; tag?: string; includeArchived?: boolean } = {}): Promise<Note[]> {
    const all = await this.notes.list(
      (n) =>
        (opts.includeArchived || !n.archived) &&
        (opts.workspaceId === undefined || (opts.workspaceId === null ? !n.workspaceId : n.workspaceId === opts.workspaceId)) &&
        (!opts.tag || n.tags.includes(opts.tag.toLowerCase())),
    );
    return all.sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  }

  async search(query: string, opts: { workspaceId?: Id } = {}) {
    return searchNotes(await this.list({ workspaceId: opts.workspaceId }), query);
  }

  async findByTitle(title: string): Promise<Note | undefined> {
    const t = title.trim().toLowerCase();
    return (await this.notes.list((n) => n.title.toLowerCase() === t))[0];
  }

  /** Notes that link to `id` with [[Title]]. */
  async backlinks(id: Id): Promise<Note[]> {
    const target = await this.notes.get(id);
    if (!target) return [];
    const t = target.title.toLowerCase();
    return this.notes.list((n) => n.id !== id && parseNote(n.body).wikiLinks.some((l) => l.toLowerCase() === t));
  }

  /** All tags with counts, for the tag sidebar. */
  async tagCounts(workspaceId?: Id): Promise<Array<[string, number]>> {
    const counts = new Map<string, number>();
    for (const n of await this.list({ workspaceId })) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }
}
