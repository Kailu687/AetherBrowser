/**
 * DOM helpers for drawing highlights. Intended for the shell's isolated-world
 * content script and for the PDF text layer — never for privileged UI.
 */

/** Concatenated text of all text nodes under root, with each node's offset. */
export function textIndex(root: Node): { text: string; nodes: Array<{ node: Text; start: number }> } {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode: (n) => {
      const p = n.parentElement;
      return p && /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName) ? 2 /* REJECT */ : 1 /* ACCEPT */;
    },
  });
  const nodes: Array<{ node: Text; start: number }> = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n as Text, start: text.length });
    text += (n as Text).data;
  }
  return { text, nodes };
}

/** Convert a selection Range to character offsets within root's text. */
export function offsetsFromRange(root: Node, range: Range): { start: number; end: number } | null {
  const { nodes } = textIndex(root);
  const find = (container: Node, offset: number) => {
    const hit = nodes.find((n) => n.node === container);
    if (hit) return hit.start + offset;
    // Element boundary: offset counts child nodes; use the first text node at or after it.
    const child = container.childNodes[offset];
    const after = child ? nodes.find((n) => child === n.node || child.contains(n.node)) : undefined;
    return after?.start ?? null;
  };
  const start = find(range.startContainer, range.startOffset);
  const end = find(range.endContainer, range.endOffset);
  return start === null || end === null || end <= start ? null : { start, end };
}

/** Wrap text[start, end) in <mark> elements (split across nodes as needed). Returns the marks for later removal. */
export function wrapRange(root: Node, start: number, end: number, attrs: Record<string, string> = {}): HTMLElement[] {
  const doc = root.ownerDocument ?? (root as Document);
  const { nodes } = textIndex(root);
  const marks: HTMLElement[] = [];
  for (const { node, start: ns } of nodes) {
    const ne = ns + node.data.length;
    if (ne <= start || ns >= end) continue;
    let target = node;
    const s = Math.max(start, ns) - ns;
    const e = Math.min(end, ne) - ns;
    if (e < target.data.length) target.splitText(e);
    if (s > 0) target = target.splitText(s);
    const mark = doc.createElement("mark");
    for (const [k, v] of Object.entries(attrs)) mark.setAttribute(k, v);
    target.parentNode!.insertBefore(mark, target);
    mark.appendChild(target);
    marks.push(mark);
  }
  return marks;
}

export function unwrap(marks: HTMLElement[]): void {
  for (const m of marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  }
}
