import MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";

/** The subset of KaTeX we use; pass the module in so KaTeX (~270 KB) is only loaded when a note has math. */
export interface KatexLike {
  renderToString(tex: string, opts: { displayMode: boolean; throwOnError: boolean; strict?: string | boolean; trust?: boolean; maxSize?: number; maxExpand?: number }): string;
}

let katexPromise: Promise<KatexLike> | undefined;
/** Lazy-load KaTeX once. Remember to include katex/dist/katex.min.css in the UI. */
export function loadKatex(): Promise<KatexLike> {
  katexPromise ??= import("katex").then((m) => (m.default ?? m) as KatexLike);
  return katexPromise;
}

export interface RenderOptions {
  katex?: KatexLike;
  /** Resolve [@key] to display text (e.g. "(Smith, 2020)" or "[3]"); unresolved keys are marked. */
  resolveCitation?: (key: string, locator?: string) => string | undefined;
  /** Whether a [[wiki link]] target exists, to style missing notes. */
  noteExists?: (title: string) => boolean;
}

export const hasMath = (src: string) => /\$\$[\s\S]+?\$\$|(?<![\\$\w])\$(?!\s)[^$\n]+?(?<!\s)\$(?![\w$])/.test(src);

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src[start] !== "$" || src[start + 1] === "$") return false;
  // Opening $ must not be followed by whitespace, closing $ not preceded by it nor followed by a digit ("$5 and $6").
  if (/\s/.test(src[start + 1] ?? " ")) return false;
  let end = start + 1;
  while ((end = src.indexOf("$", end)) !== -1) {
    if (src[end - 1] === "\\") {
      end++;
      continue;
    }
    break;
  }
  if (end === -1 || /\s/.test(src[end - 1]!) || /\d/.test(src[end + 1] ?? "")) return false;
  if (!silent) {
    const tok = state.push("math_inline", "math", 0);
    tok.content = src.slice(start + 1, end);
    tok.markup = "$";
  }
  state.pos = end + 1;
  return true;
}

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  let pos = state.bMarks[startLine]! + state.tShift[startLine]!;
  const max = state.eMarks[startLine]!;
  if (state.src.slice(pos, pos + 2) !== "$$") return false;
  pos += 2;
  let firstLine = state.src.slice(pos, max);
  let lastLine = "";
  let next = startLine;
  let found = false;
  if (firstLine.trim().endsWith("$$")) {
    firstLine = firstLine.trim().slice(0, -2);
    found = true;
  }
  while (!found) {
    next++;
    if (next >= endLine) return false;
    const p = state.bMarks[next]! + state.tShift[next]!;
    const m = state.eMarks[next]!;
    const line = state.src.slice(p, m);
    if (line.trim().endsWith("$$")) {
      lastLine = line.trim().slice(0, -2);
      found = true;
    }
  }
  if (silent) return true;
  state.line = next + 1;
  const tok = state.push("math_block", "math", 0);
  tok.block = true;
  tok.content = [firstLine, next > startLine ? state.getLines(startLine + 1, next, state.tShift[startLine]!, true) : "", lastLine].filter((s) => s.trim()).join("\n");
  tok.map = [startLine, state.line];
  tok.markup = "$$";
  return true;
}

function wikiAndCite(state: StateInline, silent: boolean): boolean {
  const src = state.src.slice(state.pos);
  const wiki = src.match(/^\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/);
  if (wiki) {
    if (!silent) {
      const tok = state.push("wikilink", "a", 0);
      tok.meta = { target: wiki[1]!.trim(), heading: wiki[2]?.trim(), label: (wiki[3] ?? wiki[1]!).trim() };
    }
    state.pos += wiki[0].length;
    return true;
  }
  const cite = src.match(/^\[(-?@[^\]\n]+)\]/);
  if (cite && /^-?@[\w]/.test(cite[1]!)) {
    const items = cite[1]!.split(";").map((p) => p.trim().match(/^-?@([\w:.#$%&\-+?<>~/]+)(?:\s*,\s*(.+))?$/));
    if (items.every(Boolean)) {
      if (!silent) {
        const tok = state.push("citation", "cite", 0);
        tok.meta = items.map((m) => ({ key: m![1]!, locator: m![2]?.trim() }));
      }
      state.pos += cite[0].length;
      return true;
    }
  }
  return false;
}

function tag(state: StateInline, silent: boolean): boolean {
  if (state.src[state.pos] !== "#") return false;
  const prev = state.src[state.pos - 1];
  if (prev !== undefined && !/[\s(]/.test(prev)) return false;
  const m = state.src.slice(state.pos).match(/^#([\p{L}_][\p{L}\p{N}_/-]*)/u);
  if (!m) return false;
  if (!silent) {
    const tok = state.push("tag", "span", 0);
    tok.content = m[1]!;
  }
  state.pos += m[0].length;
  return true;
}

export function createRenderer(opts: RenderOptions = {}): MarkdownIt {
  // html:false — raw HTML in notes is shown as text, so pasted content can't inject script or styles.
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });
  md.inline.ruler.after("escape", "math_inline", mathInline);
  md.block.ruler.before("fence", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.inline.ruler.before("link", "wiki_cite", wikiAndCite);
  md.inline.ruler.push("tag", tag);

  const tex = (src: string, display: boolean) => {
    if (!opts.katex) return `<code class="math ${display ? "math-display" : "math-inline"}" data-tex="${escapeHtml(src)}">${escapeHtml(src)}</code>`;
    try {
      // trust:false blocks \href/\url/\includegraphics; limits prevent macro-expansion DoS.
      return opts.katex.renderToString(src, { displayMode: display, throwOnError: false, strict: "ignore", trust: false, maxSize: 50, maxExpand: 500 });
    } catch (e) {
      return `<code class="math-error" title="${escapeHtml((e as Error).message)}">${escapeHtml(src)}</code>`;
    }
  };
  md.renderer.rules.math_inline = (t, i) => tex(t[i]!.content, false);
  md.renderer.rules.math_block = (t, i) => `<div class="math-block">${tex(t[i]!.content, true)}</div>\n`;
  md.renderer.rules.wikilink = (t, i) => {
    const { target, heading, label } = t[i]!.meta as { target: string; heading?: string; label: string };
    const missing = opts.noteExists && !opts.noteExists(target) ? " missing" : "";
    return `<a class="wikilink${missing}" href="#" data-note="${escapeHtml(target)}"${heading ? ` data-heading="${escapeHtml(heading)}"` : ""}>${escapeHtml(label)}</a>`;
  };
  md.renderer.rules.citation = (t, i) => {
    const items = t[i]!.meta as Array<{ key: string; locator?: string }>;
    const keys = items.map((x) => x.key).join(" ");
    const resolved = items.map((x) => opts.resolveCitation?.(x.key, x.locator));
    if (resolved.every((r) => r !== undefined)) return `<cite class="citation" data-keys="${escapeHtml(keys)}">${escapeHtml(resolved.join("; "))}</cite>`;
    const text = items.map((x, j) => resolved[j] ?? `@${x.key}${x.locator ? `, ${x.locator}` : ""}`).join("; ");
    return `<cite class="citation unresolved" data-keys="${escapeHtml(keys)}" title="Not in your library">[${escapeHtml(text)}]</cite>`;
  };
  md.renderer.rules.tag = (t, i) => `<span class="tag" data-tag="${escapeHtml(t[i]!.content.toLowerCase())}">#${escapeHtml(t[i]!.content)}</span>`;

  // Task list checkboxes.
  md.core.ruler.after("inline", "tasks", (state) => {
    const toks = state.tokens;
    for (let i = 2; i < toks.length; i++) {
      const inline = toks[i]!;
      if (inline.type !== "inline" || toks[i - 1]!.type !== "paragraph_open" || toks[i - 2]!.type !== "list_item_open") continue;
      const first = inline.children?.[0];
      const m = first?.type === "text" ? first.content.match(/^\[([ xX])\]\s+/) : null;
      if (!m || !first) continue;
      first.content = first.content.slice(m[0].length);
      const box = new state.Token("html_inline", "", 0);
      const line = inline.map?.[0] ?? toks[i - 2]!.map?.[0] ?? 0;
      box.content = `<input type="checkbox" class="task" data-line="${line}"${m[1] !== " " ? " checked" : ""}> `;
      inline.children!.unshift(box);
      toks[i - 2]!.attrJoin("class", "task-item");
    }
  });

  // External links open outside the privileged UI and never send a referrer.
  const defaultLink = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
  md.renderer.rules.link_open = (t, i, o, e, s) => {
    t[i]!.attrSet("rel", "noopener noreferrer nofollow");
    t[i]!.attrSet("target", "_blank");
    return defaultLink(t, i, o, e, s);
  };
  return md;
}

export function renderMarkdown(src: string, opts: RenderOptions = {}): string {
  return createRenderer(opts).render(src);
}
