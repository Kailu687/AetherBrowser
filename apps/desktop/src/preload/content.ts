/**
 * Web-content preload (sandboxed, isolated world). Exposes nothing to the
 * page. At document start it asks the main process what to inject (cosmetic
 * filters, uBO scriptlets) so hiding rules apply before ads paint and
 * scriptlets run before page scripts; once the DOM exists it sends class,
 * id and link names so generic hiding rules can be matched.
 */
import { ipcRenderer, webFrame } from 'electron';
import { isolateScriptlet } from './scriptlets';

interface Injection {
  css?: string;
  scripts?: string[];
}

const apply = (inj: Injection | null) => {
  if (!inj) return;
  if (inj.css) webFrame.insertCSS(inj.css, { cssOrigin: 'user' });
  // Each scriptlet gets its own function scope: they share the page's global
  // scope otherwise, so their top-level helpers (class JSONPath, safeSelf...)
  // collide or overwrite each other and break the page (seen on YouTube).
  for (const code of inj.scripts ?? []) void webFrame.executeJavaScript(isolateScriptlet(code)).catch(() => undefined);
};

if (/^https?:$/.test(location.protocol)) {
  try {
    apply(ipcRenderer.sendSync('aether:frame-start') as Injection | null);
  } catch {
    /* never break a page because filtering failed */
  }

  const seen = { classes: new Set<string>(), ids: new Set<string>(), hrefs: new Set<string>() };
  const MAX = 2000;
  let calls = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const collect = (root: ParentNode) => {
    const fresh = { classes: [] as string[], ids: [] as string[], hrefs: [] as string[] };
    for (const el of root.querySelectorAll('[class],[id],a[href]')) {
      if (seen.classes.size < MAX) for (const c of el.classList) if (c.length < 200 && !seen.classes.has(c)) (seen.classes.add(c), fresh.classes.push(c));
      if (el.id && el.id.length < 200 && seen.ids.size < MAX && !seen.ids.has(el.id)) (seen.ids.add(el.id), fresh.ids.push(el.id));
      const href = el instanceof HTMLAnchorElement ? el.href : '';
      if (href && href.length < 500 && seen.hrefs.size < MAX && !seen.hrefs.has(href)) (seen.hrefs.add(href), fresh.hrefs.push(href));
    }
    return fresh;
  };

  const send = (root: ParentNode) => {
    if (calls >= 40) return;
    const dom = collect(root);
    if (!dom.classes.length && !dom.ids.length && !dom.hrefs.length) return;
    calls++;
    void ipcRenderer.invoke('aether:frame-dom', dom).then(apply, () => undefined);
  };

  // Offer to save a password after the user signs in (main asks the user; nothing is saved silently).
  let lastSent = '';
  const grab = (root: ParentNode | null) => {
    const scope = root ?? document;
    const pw = [...scope.querySelectorAll<HTMLInputElement>('input[type="password"]')].find((i) => i.value && i.value.length <= 4096);
    if (!pw) return;
    const inputs = [...(pw.form ?? document).querySelectorAll<HTMLInputElement>('input')];
    const before = inputs.slice(0, inputs.indexOf(pw)).reverse();
    const user = before.find((i) => ['text', 'email', 'tel', ''].includes(i.type) && i.value) ?? inputs.find((i) => i.autocomplete === 'username' && i.value);
    const key = `${user?.value ?? ''}\n${pw.value}`;
    if (key === lastSent) return;
    lastSent = key;
    ipcRenderer.send('aether:login-submit', { username: (user?.value ?? '').slice(0, 1024), password: pw.value });
  };
  document.addEventListener('submit', (e) => grab(e.target instanceof HTMLFormElement ? e.target : null), true);
  document.addEventListener(
    'click',
    (e) => {
      const b = e.target instanceof Element ? e.target.closest('button, input[type="submit"], [role="button"]') : null;
      if (b) grab(b.closest('form'));
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement) grab(e.target.form);
    },
    true,
  );

  window.addEventListener('DOMContentLoaded', () => {
    send(document);
    // Late content (infinite feeds, SPAs): re-scan at most once a second.
    new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        send(document);
      }, 1000);
    }).observe(document.documentElement, { childList: true, subtree: true });
  });
}
