import { describe, it, expect } from "vitest";
import { MemoryCollection, createId, Emitter, stamp } from "@aether/research-core";

describe("core", () => {
  it("creates unique prefixed ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => createId("n")));
    expect(ids.size).toBe(500);
    expect([...ids][0]).toMatch(/^n_[0-9a-z]+$/);
  });

  it("memory collection isolates stored copies", async () => {
    const c = new MemoryCollection<{ id: string; createdAt: string; updatedAt: string; v: number[] }>();
    const item = { ...stamp({ v: [1] }) };
    await c.put(item);
    item.v.push(2);
    expect((await c.get(item.id))?.v).toEqual([1]);
    expect(await c.list((i) => i.v.length === 1)).toHaveLength(1);
    expect(await c.delete(item.id)).toBe(true);
    expect(await c.get(item.id)).toBeUndefined();
  });

  it("emitter unsubscribes", () => {
    const e = new Emitter<number>();
    const seen: number[] = [];
    const off = e.on((n) => seen.push(n));
    e.emit(1);
    off();
    e.emit(2);
    expect(seen).toEqual([1]);
  });
});
