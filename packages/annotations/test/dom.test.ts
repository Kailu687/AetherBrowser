// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { textIndex, wrapRange, unwrap, offsetsFromRange } from "@aether/annotations/dom";

describe("DOM highlighting", () => {
  it("wraps ranges across element boundaries and unwraps cleanly", () => {
    document.body.innerHTML = "<p id=r>Hello <b>bold world</b> again<script>var x = 1</script></p>";
    const root = document.getElementById("r")!;
    const { text } = textIndex(root);
    expect(text).toBe("Hello bold world again");
    const marks = wrapRange(root, 3, 14, { "data-ann": "a1" });
    expect(marks).toHaveLength(2);
    expect(root.innerHTML).toBe('Hel<mark data-ann="a1">lo </mark><b><mark data-ann="a1">bold wor</mark>ld</b> again<script>var x = 1</script>');
    const range = document.createRange();
    range.setStart(root.querySelector("b")!.firstChild!.firstChild!, 0);
    range.setEnd(root.lastChild!.previousSibling!, 3);
    unwrap(marks);
    expect(root.innerHTML).toBe("Hello <b>bold world</b> again<script>var x = 1</script>");
    const r2 = document.createRange();
    r2.setStart(root.firstChild!, 6);
    r2.setEnd(root.querySelector("b")!.firstChild!, 4);
    expect(offsetsFromRange(root, r2)).toEqual({ start: 6, end: 10 });
  });
});
