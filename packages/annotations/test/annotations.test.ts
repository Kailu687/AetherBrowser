import { describe, it, expect } from "vitest";
import { MemoryCollection } from "@aether/research-core";
import { anchor, describeRange, AnnotationStore, annotationsToMarkdown, toW3C, quoteOf, type Annotation } from "@aether/annotations";

const TEXT = "The MOSFET operates in saturation when VDS > VGS - VT. In saturation the drain current is roughly constant. Saturation also matters for amplifiers.";

describe("anchoring", () => {
  it("describes and re-anchors by position", () => {
    const start = TEXT.indexOf("drain current");
    const [q, p] = describeRange(TEXT, start, start + 13);
    expect(q.exact).toBe("drain current");
    expect(q.prefix!.endsWith("saturation the ")).toBe(true);
    expect(anchor(TEXT, q, p)).toEqual({ start, end: start + 13, method: "position" });
  });
  it("re-finds the right occurrence after the page changes", () => {
    const second = TEXT.indexOf("saturation the");
    const [q, p] = describeRange(TEXT, second, second + 10);
    const edited = "UPDATED INTRO. " + TEXT;
    const r = anchor(edited, q, p)!;
    expect(r.method).toBe("quote");
    expect(edited.slice(r.start - 3, r.end + 4)).toBe("In saturation the");
  });
  it("falls back to whitespace-insensitive matching and reports orphans", () => {
    const [q] = describeRange(TEXT, 4, 33);
    const reflowed = TEXT.replace("MOSFET operates", "MOSFET\n   operates");
    const r = anchor(reflowed, q)!;
    expect(r.method).toBe("fuzzy");
    expect(reflowed.slice(r.start, r.end)).toBe("MOSFET\n   operates in saturation");
    expect(anchor("totally different", q)).toBeNull();
  });
  it("rejects bad ranges", () => {
    expect(() => describeRange(TEXT, 5, 5)).toThrow(RangeError);
  });
});

describe("AnnotationStore", () => {
  it("stores highlights, anchors them and exports quotes with citations", async () => {
    const store = new AnnotationStore(new MemoryCollection<Annotation>());
    const s1 = TEXT.indexOf("drain current");
    const a = await store.highlight({ source: "pdf:abc", text: TEXT, start: s1, end: s1 + 34, page: 3, referenceId: "sedra2015", color: "blue" });
    const b = await store.highlight({ source: "pdf:abc", text: TEXT, start: 4, end: 10, page: 1, comment: "Device under test" });
    expect(b.motivation).toBe("commenting");
    expect((await store.forSource("pdf:abc")).map((x) => x.id)).toEqual([b.id, a.id]);
    const { anchored, orphaned } = await store.anchorAll("pdf:abc", "Totally new text", 3);
    expect(anchored).toEqual([]);
    expect(orphaned.map((x) => x.id)).toEqual([a.id]);
    await store.update(a.id, { tags: ["ids"] });
    const md = annotationsToMarkdown(await store.forSource("pdf:abc"), { heading: "Sedra notes" });
    expect(md).toBe("## Sedra notes\n\n> MOSFET (p. 1)\n\nDevice under test\n\n> drain current is roughly constant. [@sedra2015, p. 3]\n\n#ids\n");
    const w3c = toW3C((await store.forSource("pdf:abc"))[0]!);
    expect(w3c).toMatchObject({ type: "Annotation", motivation: "commenting", body: [{ value: "Device under test", purpose: "commenting" }] });
    expect(JSON.stringify(w3c)).toContain('"value":"page=1"');
    expect(quoteOf(a)!.exact).toBe("drain current is roughly constant.");
  });
});
