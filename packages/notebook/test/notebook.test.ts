import { describe, it, expect } from "vitest";
import { MemoryCollection } from "@aether/research-core";
import { parseNote, deriveTitle, toggleTask, renderMarkdown, hasMath, loadKatex, Notebook, searchNotes, noteToMarkdown, markdownToNoteInput, noteFileName, type Note } from "@aether/notebook";

const BODY = `# Op-amp notes

Gain is $A_v = -R_f / R_{in}$ for #analog circuits, see [[Feedback theory|feedback]] and [@sedra2015, p. 45; @he2016].

$$
f_c = \\frac{1}{2\\pi RC}
$$

- [ ] simulate in #LTspice
- [x] read datasheet

\`\`\`c
// #notatag [[notalink]]
\`\`\`
Costs $5 and $6 today. Heading # not tag. Issue #42.
`;

describe("parseNote", () => {
  it("extracts tags, links, citations, tasks and headings outside code/math", () => {
    const p = parseNote(BODY);
    expect(p.tags.sort()).toEqual(["analog", "ltspice"]);
    expect(p.wikiLinks).toEqual(["Feedback theory"]);
    expect(p.citations).toEqual([{ key: "sedra2015", locator: "p. 45" }, { key: "he2016" }]);
    expect(p.tasks).toEqual([
      { text: "simulate in #LTspice", done: false, line: 8 },
      { text: "read datasheet", done: true, line: 9 },
    ]);
    expect(p.headings).toEqual([{ level: 1, text: "Op-amp notes", line: 0 }]);
    expect(p.wordCount).toBeGreaterThan(10);
  });
  it("derives titles and toggles tasks", () => {
    expect(deriveTitle(BODY)).toBe("Op-amp notes");
    expect(deriveTitle("\n\n  **bold** start")).toBe("bold start");
    expect(deriveTitle("")).toBe("Untitled");
    expect(toggleTask(BODY, 8).split("\n")[8]).toBe("- [x] simulate in #LTspice");
    expect(toggleTask(BODY, 9).split("\n")[9]).toBe("- [ ] read datasheet");
  });
});

describe("renderMarkdown", () => {
  it("renders math placeholders without KaTeX and real math with it", async () => {
    const plain = renderMarkdown(BODY);
    expect(plain).toContain('<code class="math math-inline" data-tex="A_v = -R_f / R_{in}">');
    expect(plain).toContain('class="math math-display"');
    expect(plain).toContain("Costs $5 and $6 today");
    const katex = await loadKatex();
    const html = renderMarkdown(BODY, { katex });
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
  });
  it("renders wiki links, tags, task boxes and citations", () => {
    const html = renderMarkdown(BODY, {
      resolveCitation: (k, loc) => (k === "sedra2015" ? `Sedra & Smith, 2015${loc ? `, ${loc}` : ""}` : undefined),
      noteExists: () => false,
    });
    expect(html).toContain('<a class="wikilink missing" href="#" data-note="Feedback theory">feedback</a>');
    expect(html).toContain('<span class="tag" data-tag="analog">#analog</span>');
    expect(html).toContain('<input type="checkbox" class="task" data-line="8">');
    expect(html).toContain('data-line="9" checked>');
    expect(html).toContain('<cite class="citation unresolved" data-keys="sedra2015 he2016" title="Not in your library">[Sedra &amp; Smith, 2015, p. 45; @he2016]</cite>');
    expect(html).not.toContain("notalink</a>");
  });
  it("neutralises HTML, scripts and dangerous links", async () => {
    const katex = await loadKatex();
    const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) $\\href{javascript:alert(1)}{x}$ [ok](https://example.org)', { katex });
    expect(html).not.toMatch(/<script|<img|href="javascript/i);
    expect(html).toContain('href="https://example.org" rel="noopener noreferrer nofollow" target="_blank"');
  });
  it("detects math", () => {
    expect(hasMath("cost $5")).toBe(false);
    expect(hasMath("let $x$ be")).toBe(true);
    expect(hasMath("$$\na\n$$")).toBe(true);
  });
});

function clock(start = Date.UTC(2026, 9, 29, 9, 30)) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

describe("Notebook store", () => {
  it("creates, updates, retitles and lists notes per workspace", async () => {
    const c = clock();
    const nb = new Notebook(new MemoryCollection<Note>(), c);
    const events: string[] = [];
    nb.events.on((e) => events.push(e.type));
    const a = await nb.create({ body: "# VLSI prep\n#vlsi timing closure", workspaceId: "ws_vlsi" });
    c.advance(1000);
    const b = await nb.create({ body: "# Wing loading\n#aircraft", workspaceId: "ws_aero" });
    expect(a.tags).toEqual(["vlsi"]);
    expect((await nb.list({ workspaceId: "ws_vlsi" })).map((n) => n.id)).toEqual([a.id]);
    expect((await nb.list()).map((n) => n.id)).toEqual([b.id, a.id]);
    c.advance(1000);
    const a2 = await nb.update(a.id, { body: "# VLSI internship prep\n#vlsi #sta" });
    expect(a2.title).toBe("VLSI internship prep");
    expect(a2.tags).toEqual(["vlsi", "sta"]);
    await nb.update(a.id, { title: "Custom", body: "# Something else" });
    expect((await nb.get(a.id))!.title).toBe("Custom");
    expect(await nb.delete(b.id)).toBe(true);
    expect(events).toEqual(["created", "created", "updated", "updated", "deleted"]);
  });

  it("quick capture appends to a per-workspace daily inbox", async () => {
    const c = clock();
    const nb = new Notebook(new MemoryCollection<Note>(), c);
    const n1 = await nb.capture("Try a canard layout", { workspaceId: "ws_aero", source: { url: "https://example.org/canard", title: "Canards" } });
    c.advance(60_000);
    const n2 = await nb.capture("Check stall margins", { workspaceId: "ws_aero" });
    const other = await nb.capture("Read STA chapter", { workspaceId: "ws_vlsi" });
    expect(n2.id).toBe(n1.id);
    expect(other.id).not.toBe(n1.id);
    expect(n2.body).toBe("# Inbox 2026-10-29\n\n- 09:30 Try a canard layout ([Canards](https://example.org/canard))\n- 09:31 Check stall margins\n");
    expect(n2.sources).toHaveLength(1);
  });

  it("searches, finds backlinks and counts tags", async () => {
    const nb = new Notebook(new MemoryCollection<Note>(), clock());
    const target = await nb.create({ body: "# Feedback theory\nLoop gain and phase margin. #control" });
    await nb.create({ body: "# Op-amps\nSee [[feedback theory]] for stabilité. #analog #control" });
    await nb.create({ body: "# Unrelated\nGroceries" });
    const hits = await nb.search("feed");
    expect(hits.map((h) => h.note.title)).toEqual(["Feedback theory", "Op-amps"]);
    expect((await nb.search("stabilite"))[0]!.snippet).toContain("stabilité");
    expect((await nb.search("#analog control")).map((h) => h.note.title)).toEqual(["Op-amps"]);
    expect((await nb.backlinks(target.id)).map((n) => n.title)).toEqual(["Op-amps"]);
    expect(await nb.tagCounts()).toEqual([["control", 2], ["analog", 1]]);
    expect(searchNotes([], "x")).toEqual([]);
  });
});

describe("import/export", () => {
  it("round-trips front matter and makes safe filenames", () => {
    const note: Note = { id: "n", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", title: 'Radar "notes": FMCW', body: "Body #radar", tags: ["radar"], sources: [{ url: "https://x.org/a", capturedAt: "" }] };
    const md = noteToMarkdown(note);
    expect(md).toContain('title: "Radar \\"notes\\": FMCW"');
    expect(markdownToNoteInput(md)).toEqual({ title: 'Radar "notes": FMCW', body: "Body #radar\n", sources: ["https://x.org/a"] });
    expect(markdownToNoteInput("plain")).toEqual({ body: "plain", sources: [] });
    expect(noteFileName({ title: 'a/b:c*?"<>|' })).toBe("abc.md");
    expect(noteFileName({ title: "CON" })).toBe("CON_.md");
  });
});
