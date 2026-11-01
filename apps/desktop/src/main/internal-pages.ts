import type { InternalPageHandler, InternalPageResponse, SessionContext } from '@aether/plugin-api';
import { resolveOmniboxInput } from '@aether/omnibox';
import type { AetherStore } from '@aether/storage';
import { DEFAULT_THEME, THEMES, themeCss, type Theme } from '../shared/themes';
import type { ReaderStore } from './reader';

/**
 * aether:// internal pages. They are served into ordinary sandboxed web views
 * with a strict CSP and no scripts. They have no access to IPC.
 */

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action aether:; base-uri 'none'; frame-ancestors 'none'";

const FALLBACK_THEME = THEMES[DEFAULT_THEME];

export function page(title: string, body: string, extraCss = '', theme: Theme = FALLBACK_THEME): string {
  return `<!doctype html><html data-theme="${theme.id}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>${escapeHtml(title)}</title>
<style>
:root{${themeCss(theme)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 var(--font);min-height:100vh}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:760px;margin:0 auto;padding:12vh 24px 48px}
.muted{color:var(--muted)}
${extraCss}
</style></head><body>${body}</body></html>`;
}

const QUICK = [
  ['!scholar', 'Scholar'],
  ['!arxiv', 'arXiv'],
  ['!ieee', 'IEEE'],
  ['!ds', 'Datasheets'],
  ['!gh', 'GitHub'],
  ['!so', 'Stack Overflow'],
  ['!wa', 'Wolfram'],
  ['!yt', 'YouTube'],
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

const PRIVATE_NOTE =
  '<p class="muted note">This window keeps no history, cookies or site data after you close it. Downloads and bookmarks you create stay on this device. Your network, employer or the sites you visit can still see your activity.</p>';

function newTabPage(store: AetherStore, ctx: SessionContext, theme: Theme): string {
  const profile = store.getProfile(ctx.profileId);
  const top = ctx.isPrivate ? [] : store.topSites(ctx.profileId, 8);
  return theme.id === 'aviation' ? cockpitNewTab(profile?.name ?? '', top, ctx, theme) : standardNewTab(profile, top, ctx, theme);
}

function standardNewTab(profile: { name: string; color: string } | null, top: { url: string; title: string }[], ctx: SessionContext, theme: Theme): string {
  const hour = new Date().getHours();
  const greeting = ctx.isPrivate ? 'Private window' : hour < 5 ? 'Late night session' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const tiles = top
    .map((e) => {
      const host = hostOf(e.url);
      const letter = escapeHtml((host[0] ?? '?').toUpperCase());
      return `<a class="tile" href="${escapeHtml(e.url)}"><span class="letter">${letter}</span><span class="name">${escapeHtml(e.title || host)}</span><span class="host">${escapeHtml(host)}</span></a>`;
    })
    .join('');
  const quick = QUICK.map(([bang, label]) => `<span class="chip" title="Type ${bang} &lt;query&gt; in the address bar">${escapeHtml(bang)} <span class="muted">${escapeHtml(label)}</span></span>`).join('');
  const body = `<main class="wrap">
  <div class="brand">AETHER</div>
  <h1>${escapeHtml(greeting)}${profile && !ctx.isPrivate ? `, <span class="who">${escapeHtml(profile.name)}</span>` : ''}</h1>
  ${ctx.isPrivate ? PRIVATE_NOTE : ''}
  <form action="aether://search" method="get" class="search"><input name="q" placeholder="Search or type a URL. Try “!ds LM358” or “!arxiv radar”" autocomplete="off" aria-label="Search"></form>
  <div class="chips">${quick}</div>
  ${tiles ? `<h2>Frequently visited</h2><div class="tiles">${tiles}</div>` : ''}
</main>`;
  const signature =
    theme.id === 'aether'
      ? `body{background:
  radial-gradient(1px 1px at 12% 18%,rgba(255,255,255,.55),transparent 60%),radial-gradient(1px 1px at 72% 12%,rgba(255,255,255,.4),transparent 60%),
  radial-gradient(1.5px 1.5px at 38% 64%,rgba(255,255,255,.35),transparent 60%),radial-gradient(1px 1px at 86% 58%,rgba(255,255,255,.45),transparent 60%),
  radial-gradient(1px 1px at 22% 84%,rgba(255,255,255,.3),transparent 60%),radial-gradient(1px 1px at 58% 32%,rgba(255,255,255,.3),transparent 60%),
  radial-gradient(900px 420px at 80% -8%,color-mix(in srgb,var(--accent) 22%,transparent),transparent 70%),
  radial-gradient(700px 360px at 5% 105%,color-mix(in srgb,var(--accent-2) 14%,transparent),transparent 70%),var(--bg)}
.brand{background:linear-gradient(90deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent}
.who{background:linear-gradient(90deg,var(--accent),var(--accent-2));-webkit-background-clip:text;background-clip:text;color:transparent}`
      : `.who{color:var(--accent)}`;
  const css = `.brand{letter-spacing:.5em;font-weight:700;font-size:12px;color:var(--muted)}
h1{font-weight:600;font-size:32px;margin:8px 0 24px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:40px 0 12px;font-weight:600}
.note{margin-top:-8px}
.search input{width:100%;padding:16px 20px;border-radius:calc(var(--radius) + 4px);border:1px solid var(--line);background:var(--surface);color:var(--fg);font:inherit;font-size:17px;outline:none}
.search input:focus{border-color:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 20%,transparent)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.chip{font-size:12.5px;padding:4px 10px;border:1px solid var(--line);border-radius:999px;background:var(--surface)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.tile{display:grid;grid-template-columns:36px 1fr;grid-template-rows:auto auto;column-gap:10px;padding:12px;border-radius:calc(var(--radius) + 2px);background:var(--surface);border:1px solid var(--line);color:var(--fg)}
.tile:hover{text-decoration:none;border-color:var(--accent)}
.letter{grid-row:span 2;width:36px;height:36px;border-radius:var(--radius);display:grid;place-items:center;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);font-weight:700}
.name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13.5px}.host{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
${signature}`;
  return page('New Tab', body, css, theme);
}

/** Static attitude indicator (no script): sky, ground, pitch ladder, aircraft symbol. */
const ATTITUDE_SVG = `<svg class="adi" viewBox="0 0 200 200" role="img" aria-label="Attitude indicator">
<defs><clipPath id="c"><circle cx="100" cy="100" r="88"/></clipPath></defs>
<g clip-path="url(#c)" transform="rotate(-6 100 100)">
<rect x="-50" y="-50" width="300" height="158" fill="#1f6fb8"/><rect x="-50" y="108" width="300" height="160" fill="#7a4a24"/>
<line x1="-50" y1="108" x2="250" y2="108" stroke="#fff" stroke-width="2"/>
<g stroke="#fff" stroke-width="1.5"><line x1="80" y1="88" x2="120" y2="88"/><line x1="88" y1="98" x2="112" y2="98"/><line x1="80" y1="68" x2="120" y2="68"/><line x1="88" y1="118" x2="112" y2="118"/><line x1="80" y1="128" x2="120" y2="128"/></g>
</g>
<circle cx="100" cy="100" r="88" fill="none" stroke="#26394a" stroke-width="6"/>
<g stroke="#ffb000" stroke-width="5" fill="none" stroke-linecap="square"><path d="M50 100h30l8 8"/><path d="M150 100h-30l-8 8"/></g>
<rect x="97" y="97" width="6" height="6" fill="#ffb000"/>
<path d="M100 14l-6 10h12z" fill="#ffb000"/>
</svg>`;

function cockpitNewTab(name: string, top: { url: string; title: string }[], ctx: SessionContext, theme: Theme): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const utc = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}Z`;
  const local = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }).toUpperCase();
  // Decorative heading: the compass card turns once a day with the local clock.
  const hdg = Math.round((now.getHours() * 60 + now.getMinutes()) / 4) % 360;
  const card = Array.from({ length: 72 }, (_, i) => {
    const a = i * 5;
    const long = a % 10 === 0;
    const label = a % 30 === 0 ? (({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' }) as Record<number, string>)[a] ?? String(a / 10) : '';
    return `<g transform="rotate(${a} 100 100)"><line x1="100" y1="14" x2="100" y2="${long ? 24 : 19}" stroke="#d8e4ec" stroke-width="${long ? 1.6 : 1}"/>${label ? `<text x="100" y="38" text-anchor="middle" fill="${label.length === 1 ? '#ffb000' : '#d8e4ec'}" font-size="12" font-family="Bahnschrift,Segoe UI,sans-serif">${label}</text>` : ''}</g>`;
  }).join('');
  const hsi = `<svg class="hsi" viewBox="0 0 200 200" role="img" aria-label="Heading indicator">
<circle cx="100" cy="100" r="92" fill="#05080b" stroke="#26394a" stroke-width="6"/>
<g transform="rotate(${-hdg} 100 100)">${card}<path d="M100 48v104" stroke="#3ddc84" stroke-width="3"/><path d="M100 46l-7 12h14z" fill="#3ddc84"/></g>
<path d="M100 82c-2 0-3 2-3 5v8l-17 9v4l17-4v12l-6 4v3l9-2 9 2v-3l-6-4v-12l17 4v-4l-17-9v-8c0-3-1-5-3-5z" fill="#ffb000"/>
<path d="M100 3l-6 9h12z" fill="#ffb000"/>
</svg>`;
  const plan = top
    .map((e, i) => {
      const host = hostOf(e.url);
      const ident = host.replace(/[^a-z0-9]/gi, '').slice(0, 5).toUpperCase();
      return `<a class="wpt" href="${escapeHtml(e.url)}"><span class="n">${pad(i + 1)}</span><span class="id">${escapeHtml(ident)}</span><span class="t">${escapeHtml(e.title || host)}</span><span class="h">${escapeHtml(host)}</span></a>`;
    })
    .join('');
  const quick = QUICK.map(([bang, label]) => `<span class="chip"><b>${escapeHtml(bang.slice(1).toUpperCase())}</b> ${escapeHtml(label)}</span>`).join('');
  const body = `<main class="cockpit">
  <svg class="liner" viewBox="0 0 16 16" aria-hidden="true"><path d="M14.5 8c0-.6-.9-1-2-1H10L6.5 2.5H5.2L7 7H4L2.8 5.2h-1L2.4 8l-.6 2.8h1L4 9h3l-1.8 4.5h1.3L10 9h2.5c1.1 0 2-.4 2-1z"/></svg>
  <div class="annunciator"><span class="lamp g">AETHER</span><span class="lamp">${ctx.isPrivate ? 'PRIVATE' : escapeHtml(name.toUpperCase() || 'CREW')}</span><span class="sp"></span><span class="lamp">${escapeHtml(date)}</span><span class="lamp a">UTC ${utc}</span></div>
  <section class="panel">
    <div class="fma"><span class="g">SPEED</span><span class="g">NAV</span><span class="g">ALT</span><span class="w">AP1</span><span class="w">A/THR</span></div>
    <div class="instruments">
      ${ATTITUDE_SVG}
      ${hsi}
      <div class="readouts">
        <div class="ro"><span>LCL</span><b>${local}</b></div>
        <div class="ro"><span>UTC</span><b>${utc}</b></div>
        <div class="ro"><span>HDG</span><b>${String(hdg).padStart(3, '0')}°</b></div>
        <div class="ro"><span>WPTS</span><b>${pad(top.length)}</b></div>
      </div>
    </div>
  </section>
  <h1>${ctx.isPrivate ? 'Private flight. No logbook kept.' : `Cleared for takeoff${name ? `, ${escapeHtml(name)}` : ''}.`}</h1>
  ${ctx.isPrivate ? PRIVATE_NOTE : ''}
  <form action="aether://search" method="get" class="search"><span class="prompt">DEST</span><input name="q" placeholder="URL, search or !bang shortcut" autocomplete="off" aria-label="Search"></form>
  <div class="chips">${quick}</div>
  ${plan ? `<h2>Flight plan · frequent destinations</h2><div class="plan">${plan}</div>` : ''}
</main>`;
  // Night sky above the panel and the glow of the Earth's limb below it.
  const css = `body{min-height:100vh;background:
  radial-gradient(1px 1px at 8% 12%,rgba(216,228,236,.6),transparent 60%),radial-gradient(1px 1px at 22% 30%,rgba(216,228,236,.35),transparent 60%),
  radial-gradient(1.5px 1.5px at 41% 9%,rgba(255,176,0,.45),transparent 60%),radial-gradient(1px 1px at 63% 24%,rgba(216,228,236,.45),transparent 60%),
  radial-gradient(1px 1px at 79% 7%,rgba(216,228,236,.5),transparent 60%),radial-gradient(1.5px 1.5px at 91% 33%,rgba(61,220,132,.4),transparent 60%),
  radial-gradient(1px 1px at 14% 58%,rgba(216,228,236,.3),transparent 60%),radial-gradient(1px 1px at 87% 64%,rgba(216,228,236,.3),transparent 60%),
  radial-gradient(150% 55% at 50% 128%,color-mix(in srgb,#2e7bd6 38%,transparent) 0 54%,color-mix(in srgb,var(--accent-2) 22%,transparent) 57%,transparent 63%),
  radial-gradient(circle at 50% -20%,color-mix(in srgb,var(--accent-2) 8%,transparent),transparent 60%),var(--bg);background-attachment:fixed}
.cockpit{max-width:820px;margin:0 auto;padding:6vh 24px 48px;font-variant-numeric:tabular-nums}
.annunciator{display:flex;gap:8px;align-items:center;font:600 11px/1 var(--label-font);letter-spacing:.14em}
.lamp{padding:5px 8px;border:1px solid var(--line);background:#05080b;color:var(--muted)}.lamp.g{color:var(--accent-2);border-color:color-mix(in srgb,var(--accent-2) 40%,var(--line))}.lamp.a{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,var(--line))}.sp{flex:1}
.liner{position:fixed;top:4vh;right:-60px;width:420px;height:420px;fill:var(--fg);opacity:.035;transform:rotate(-18deg);pointer-events:none}
.panel{margin:22px 0 8px;padding:12px 18px 18px;border:1px solid var(--line);background:linear-gradient(180deg,#0b1218,#070b0f);border-radius:6px;box-shadow:inset 0 0 0 4px #05080b}
.fma{display:grid;grid-template-columns:repeat(5,1fr);margin-bottom:14px;border:1px solid var(--line);background:#05080b;font:600 11px var(--label-font);letter-spacing:.14em;text-align:center}.fma span{padding:5px 0;border-left:1px solid var(--line)}.fma span:first-child{border-left:0}.fma .g{color:var(--accent-2)}.fma .w{color:#d8e4ec}
.instruments{display:flex;gap:22px;align-items:center}
.adi,.hsi{width:150px;height:150px;flex-shrink:0}
.readouts{display:grid;grid-template-columns:repeat(2,minmax(110px,1fr));gap:10px;flex:1}
@media (max-width:760px){.hsi{display:none}}
.ro{display:flex;justify-content:space-between;align-items:baseline;padding:8px 12px;background:#05080b;border:1px solid var(--line);border-radius:3px}
.ro span{font:600 11px var(--label-font);letter-spacing:.14em;color:var(--muted)}.ro b{font:600 22px var(--label-font);color:var(--accent-2)}
h1{font:600 26px var(--label-font);letter-spacing:.02em;margin:22px 0 16px}
h2{font:600 11px var(--label-font);text-transform:uppercase;letter-spacing:.16em;color:var(--accent-2);margin:34px 0 10px}
.search{display:flex;align-items:center;border:1px solid var(--line);background:#05080b;border-radius:3px}
.search:focus-within{border-color:var(--accent-2);box-shadow:0 0 0 1px var(--accent-2),0 0 18px color-mix(in srgb,var(--accent-2) 25%,transparent)}
.prompt{font:700 12px var(--label-font);letter-spacing:.16em;color:var(--accent);padding:0 6px 0 16px}
.search input{flex:1;padding:15px 16px 15px 8px;border:0;background:transparent;color:var(--accent-2);font:500 17px var(--label-font);outline:none;caret-color:var(--accent-2)}
.search input::placeholder{color:color-mix(in srgb,var(--accent-2) 40%,transparent)}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}.chip{font:500 12px var(--label-font);padding:4px 9px;border:1px solid var(--line);border-radius:3px;color:var(--muted);background:#05080b}.chip b{color:var(--accent);letter-spacing:.08em}
.plan{border:1px solid var(--line);border-radius:3px;overflow:hidden}
.wpt{display:grid;grid-template-columns:36px 70px 1fr 200px;gap:12px;align-items:center;padding:9px 12px;border-top:1px solid var(--line);color:var(--fg);font-family:var(--label-font)}
.wpt:first-child{border-top:0}.wpt:hover{background:#0f1a22;text-decoration:none}
.wpt .n{color:var(--muted)}.wpt .id{color:var(--accent);letter-spacing:.1em;font-weight:700}.wpt .t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.wpt .h{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:right}`;
  return page('New Tab', body, css, theme);
}

export function blockedPage(url: string, reason: string, theme: Theme = FALLBACK_THEME): string {
  return page('Blocked', `<main class="wrap"><h1>This page was held back</h1><p>${escapeHtml(reason)}</p><p class="muted">${escapeHtml(url)}</p></main>`, 'h1{font-weight:600}', theme);
}

function aboutPage(version: string, versions: Record<string, string | undefined>, theme: Theme): string {
  const rows = Object.entries(versions)
    .filter(([, val]) => val)
    .map(([k, val]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(val))}</td></tr>`)
    .join('');
  return page(
    'About AETHER',
    `<main class="wrap"><h1>AETHER ${escapeHtml(version)}</h1><p>Browse deeply. Research intelligently. Build without distraction.</p>
<p class="muted">A local-first browser. No account, cloud service or telemetry is required. Licensed under MPL-2.0. Built on Electron and Chromium, whose licenses ship with the app (LICENSES.chromium.html).</p>
<table>${rows}</table><p class="muted">Theme: ${escapeHtml(theme.name)}</p></main>`,
    'td{padding:4px 16px 4px 0}td:first-child{color:var(--muted)}',
    theme,
  );
}

export interface InternalPagesDeps {
  store: AetherStore;
  version: string;
  theme: () => Theme;
  reader: ReaderStore;
}

export class InternalPages {
  private handlers = new Map<string, InternalPageHandler>();

  constructor(private deps: InternalPagesDeps) {
    this.register('newtab', (_url, ctx) => ({ html: newTabPage(deps.store, ctx, deps.theme()) }));
    this.register('search', (url, ctx) => {
      const q = url.searchParams.get('q') ?? '';
      const engine = deps.store.getProfile(ctx.profileId)?.searchEngine ?? 'google';
      const r = resolveOmniboxInput(q, { engine });
      if (r.kind === 'invalid') return { redirect: 'aether://newtab' };
      return { redirect: r.url };
    });
    this.register('blocked', (url) => ({ html: blockedPage(url.searchParams.get('url') ?? '', url.searchParams.get('reason') ?? 'Blocked by a rule.', deps.theme()) }));
    this.register('reader', (url, ctx) => deps.reader.page(url, ctx, deps.theme()));
    this.register('about', () => ({ html: aboutPage(deps.version, { Electron: process.versions.electron, Chromium: process.versions.chrome, 'Node.js': process.versions.node, V8: process.versions.v8, SQLite: process.versions.sqlite }, deps.theme()) }));
  }

  register(name: string, handler: InternalPageHandler): void {
    if (!/^[a-z][a-z0-9.-]{0,47}$/.test(name)) throw new Error(`Invalid internal page name: ${name}`);
    if (this.handlers.has(name)) throw new Error(`Internal page already registered: ${name}`);
    this.handlers.set(name, handler);
  }

  has(name: string): boolean {
    return this.handlers.has(name);
  }

  async handle(rawUrl: string, ctx: SessionContext): Promise<Response> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const handler = this.handlers.get(url.hostname);
    if (!handler) return html(page('Not found', `<main class="wrap"><h1>Page not found</h1><p class="muted">${escapeHtml(rawUrl)}</p></main>`), 404);
    let res: InternalPageResponse;
    try {
      res = await handler(url, ctx);
    } catch (err) {
      return html(page('Error', `<main class="wrap"><h1>Something went wrong</h1><p class="muted">${escapeHtml(String(err))}</p></main>`), 500);
    }
    if ('redirect' in res) return new Response(null, { status: 302, headers: { Location: res.redirect } });
    if ('html' in res) return html(res.html, 200, res.allowRemoteImages ? CSP.replace("img-src data:", 'img-src https: http: data:') : CSP);
    return new Response(res.body as BodyInit, {
      status: res.status ?? 200,
      headers: { 'Content-Type': res.contentType ?? 'text/plain; charset=utf-8', ...res.headers, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' },
    });
  }
}

function html(body: string, status = 200, csp = CSP): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
}
