import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import type { InternalPageResponse, SessionContext } from '@aether/plugin-api';
import { themeCss, type Theme } from '../shared/themes';
import { escapeHtml } from './internal-pages';

/**
 * Reader mode: Mozilla Readability runs in an isolated world of the tab,
 * the result is sanitised there (allowlisted tags and attributes, http(s)
 * links and images only) and shown at aether://reader/ with a CSP that
 * allows no scripts. Articles live in memory, per session partition.
 */

export interface Article {
  title: string;
  byline: string;
  siteName: string;
  content: string;
  length: number;
  lang: string;
}

const READER_WORLD = 1003;
const MAX_ARTICLES = 30;

let readabilitySource: string | null = null;
const readability = () => (readabilitySource ??= readFileSync(join(__dirname, 'readability.js'), 'utf8'));

/** Runs in the isolated world: parse, then rebuild the article from an allowlist. */
const EXTRACT = `
const article = new Readability(document.cloneNode(true), { charThreshold: 400 }).parse();
if (!article || !article.content) return null;
const TAGS = new Set(['P','A','H1','H2','H3','H4','H5','H6','UL','OL','LI','BLOCKQUOTE','PRE','CODE','EM','STRONG','B','I','U','S','SUB','SUP','BR','HR','IMG','FIGURE','FIGCAPTION','TABLE','THEAD','TBODY','TFOOT','TR','TH','TD','CAPTION','DL','DT','DD','MARK','SMALL','ABBR','TIME','KBD','SAMP','VAR','Q','CITE','DEL','INS','PICTURE','SECTION','ARTICLE','DIV','SPAN']);
const DROP = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','INPUT','BUTTON','SELECT','TEXTAREA','SVG','MATH','CANVAS','VIDEO','AUDIO','SOURCE','NOSCRIPT','LINK','META','BASE','TEMPLATE','DIALOG']);
const safeUrl = (u, img) => { try { const x = new URL(u, location.href); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : (img && x.protocol === 'data:' && /^data:image\\/(png|jpe?g|gif|webp);/i.test(u) ? u : ''); } catch { return ''; } };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const out = [];
const walk = (node) => {
  for (const n of node.childNodes) {
    if (n.nodeType === 3) { out.push(esc(n.nodeValue)); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    if (DROP.has(tag)) continue;
    if (!TAGS.has(tag)) { walk(n); continue; }
    const t = tag.toLowerCase();
    let attrs = '';
    if (tag === 'A') { const h = safeUrl(n.getAttribute('href') || '', false); if (h) attrs += ' href="' + esc(h) + '" rel="noreferrer"'; }
    if (tag === 'IMG') { const s = safeUrl(n.getAttribute('src') || n.getAttribute('data-src') || '', true); if (!s) continue; attrs += ' src="' + esc(s) + '" alt="' + esc(n.getAttribute('alt') || '') + '" loading="lazy" referrerpolicy="no-referrer"'; }
    if (tag === 'TD' || tag === 'TH') { for (const a of ['colspan','rowspan']) { const v = n.getAttribute(a); if (v && /^\\d{1,3}$/.test(v)) attrs += ' ' + a + '="' + v + '"'; } }
    if (tag === 'BR' || tag === 'HR' || tag === 'IMG') { out.push('<' + t + attrs + '>'); continue; }
    out.push('<' + t + attrs + '>'); walk(n); out.push('</' + t + '>');
  }
};
const doc = new DOMParser().parseFromString(article.content, 'text/html');
walk(doc.body);
return { title: article.title || document.title, byline: article.byline || '', siteName: article.siteName || location.hostname, content: out.join(''), length: article.length || 0, lang: article.lang || document.documentElement.lang || '' };
`;

export class ReaderStore {
  private articles = new Map<string, { article: Article; src: string; partition: string }>();

  async extract(wc: WebContents): Promise<Article | null> {
    const code = `(() => { ${readability()}\n${EXTRACT} })()`;
    const r = (await wc.executeJavaScriptInIsolatedWorld(READER_WORLD, [{ code }], false)) as Article | null;
    if (!r || typeof r.content !== 'string' || r.content.length < 200) return null;
    return { title: String(r.title).slice(0, 500), byline: String(r.byline ?? '').slice(0, 300), siteName: String(r.siteName ?? '').slice(0, 200), content: r.content.slice(0, 2_000_000), length: Number(r.length) || 0, lang: String(r.lang ?? '').slice(0, 20) };
  }

  /** Saves an article and returns the aether://reader URL that shows it. */
  put(article: Article, src: string, partition: string): string {
    const id = randomUUID();
    this.articles.set(id, { article, src, partition });
    while (this.articles.size > MAX_ARTICLES) this.articles.delete(this.articles.keys().next().value!);
    return `aether://reader/?id=${id}&src=${encodeURIComponent(src)}`;
  }

  static sourceOf(readerUrl: string): string | null {
    try {
      const u = new URL(readerUrl);
      if (u.protocol !== 'aether:' || u.hostname !== 'reader') return null;
      const src = u.searchParams.get('src') ?? '';
      return /^https?:\/\//i.test(src) ? src : null;
    } catch {
      return null;
    }
  }

  page(url: URL, ctx: SessionContext, theme: Theme): InternalPageResponse {
    const id = url.searchParams.get('id') ?? '';
    const src = ReaderStore.sourceOf(url.href);
    const entry = this.articles.get(id);
    // Articles are only shown in the session that made them; otherwise go back to the page.
    if (!entry || entry.partition !== ctx.partition) return src ? { redirect: src } : { redirect: 'aether://newtab/' };
    const size = Math.min(26, Math.max(14, Number(url.searchParams.get('size')) || 19));
    const serif = url.searchParams.get('font') !== 'sans';
    const link = (patch: Record<string, string>) => {
      const q = new URLSearchParams(url.searchParams);
      for (const [k, v] of Object.entries(patch)) q.set(k, v);
      return `aether://reader/?${q.toString()}`;
    };
    const { article } = entry;
    const minutes = Math.max(1, Math.round(article.length / 1100));
    const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src https: http: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    const html = `<!doctype html><html lang="${escapeHtml(article.lang)}" data-theme="${theme.id}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">
<title>${escapeHtml(article.title)}</title>
<style>
:root{${themeCss(theme)}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:${size}px/1.7 ${serif ? "Charter,'Iowan Old Style',Georgia,Cambria,'Times New Roman',serif" : 'var(--font)'}}
.bar{position:sticky;top:0;display:flex;gap:6px;align-items:center;justify-content:center;padding:8px;background:var(--chrome);border-bottom:1px solid var(--line);font:13px var(--font)}
.bar a{color:var(--fg);padding:4px 10px;border:1px solid var(--line);border-radius:var(--radius);text-decoration:none}
.bar a:hover{border-color:var(--accent)}
.bar .on{background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
main{max-width:68ch;margin:0 auto;padding:40px 24px 120px}
.site{color:var(--accent);font:600 12px var(--label-font);letter-spacing:.08em;text-transform:uppercase}
h1{font-size:1.9em;line-height:1.2;margin:.3em 0 .4em}
.meta{color:var(--muted);font:14px var(--font);margin-bottom:2em}
a{color:var(--accent)}
img{max-width:100%;height:auto;border-radius:6px}
figure{margin:1.5em 0}figcaption{color:var(--muted);font-size:.85em}
pre{background:var(--surface);padding:12px 14px;border-radius:var(--radius);overflow:auto;font:.8em/1.5 'Cascadia Mono',Consolas,ui-monospace,monospace}
code{font-family:'Cascadia Mono',Consolas,ui-monospace,monospace;font-size:.88em}
blockquote{margin:1.2em 0;padding-left:1em;border-left:3px solid var(--accent);color:var(--muted)}
table{border-collapse:collapse;font-size:.85em;display:block;overflow:auto}td,th{border:1px solid var(--line);padding:4px 8px}
hr{border:0;border-top:1px solid var(--line)}
</style></head><body>
<nav class="bar">
<a href="${escapeHtml(src ?? 'aether://newtab/')}">Original page</a>
<a href="${escapeHtml(link({ size: String(size - 1) }))}" title="Smaller text">A−</a>
<a href="${escapeHtml(link({ size: String(size + 1) }))}" title="Larger text">A+</a>
<a class="${serif ? 'on' : ''}" href="${escapeHtml(link({ font: 'serif' }))}">Serif</a>
<a class="${serif ? '' : 'on'}" href="${escapeHtml(link({ font: 'sans' }))}">Sans</a>
</nav>
<main>
<div class="site">${escapeHtml(article.siteName)}</div>
<h1>${escapeHtml(article.title)}</h1>
<div class="meta">${article.byline ? `${escapeHtml(article.byline)} · ` : ''}${minutes} min read</div>
${article.content}
</main></body></html>`;
    return { html, allowRemoteImages: true };
  }
}
