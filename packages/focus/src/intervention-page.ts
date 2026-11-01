import type { FocusEngine, InterventionChoice } from './engine.js';
import { BASE_STYLES, INTERNAL_PAGE_CSP, escapeHtml } from './html.js';

export type InternalPageResult = { html: string; headers?: Record<string, string> } | { redirect: string };

function delayedStyle(seconds: number, cls: string): string {
  if (seconds <= 0) return '';
  // Without scripts, a CSS animation reveals the control after the pause; the engine also
  // rejects early choices, so this is presentation only.
  return `.${cls}{visibility:hidden;animation:reveal-${cls} 0s linear ${seconds}s forwards}@keyframes reveal-${cls}{to{visibility:visible}}`;
}

/**
 * Serves aether://intervention/?id=... (the screen) and
 * aether://intervention/resolve?id=...&choice=... (applies the choice and redirects).
 * Choices are plain GET links so the page needs no privileged API or script.
 */
export function handleInterventionPage(engine: FocusEngine, url: URL): InternalPageResult {
  const id = url.searchParams.get('id') ?? '';
  if (url.pathname.replace(/\/+$/, '').endsWith('/resolve')) {
    const choice = url.searchParams.get('choice') as InterventionChoice;
    const minutes = url.searchParams.has('minutes') ? Number(url.searchParams.get('minutes')) : undefined;
    const result = engine.resolveIntervention(id, choice, minutes);
    if ('error' in result) {
      const u = new URL(result.redirect);
      if (u.href.startsWith(engine.interventionBaseUrl)) u.searchParams.set('notice', result.error);
      return { redirect: u.toString() };
    }
    return { redirect: result.redirect };
  }
  return { html: renderInterventionHtml(engine, id, url.searchParams.get('notice') ?? undefined), headers: { 'Content-Security-Policy': INTERNAL_PAGE_CSP } };
}

export function renderInterventionHtml(engine: FocusEngine, id: string, notice?: string): string {
  const iv = engine.getIntervention(id);
  const base = engine.interventionBaseUrl;
  if (!iv) {
    return page(
      'Nothing to decide here',
      `<h1>Nothing to decide here</h1><p class="muted">This prompt has expired, probably because the focus session ended.</p><p><a class="btn primary" href="aether://newtab/">Open a new tab</a></p>`,
      '',
    );
  }
  const status = engine.status();
  const opts = engine.interventionOptions(iv);
  const action = (choice: string, extra = '') => `${base}resolve?id=${encodeURIComponent(iv.id)}&amp;choice=${choice}${extra}`;
  const elapsed = Math.floor(status.elapsedMs / 60_000);
  const heading = iv.action === 'warn' ? `Heading to ${escapeHtml(iv.site)}?` : `${escapeHtml(iv.site)} is paused during ${escapeHtml(status.modeConfig?.label ?? 'this session')}`;
  const reason = iv.label ? escapeHtml(iv.label) : `It matches your rule <code>${escapeHtml(iv.pattern)}</code>.`;
  const goal = iv.goal ? `<p class="goal">You set out to: <strong>${escapeHtml(iv.goal)}</strong></p>` : '';
  const continueBtn =
    opts.continueAfterSeconds === null
      ? ''
      : `<a class="btn cont" href="${action('continue')}">Continue to the page</a>`;
  const allowBtns = opts.allowMinutes.map((m) => `<a class="btn allow" href="${action('allow', `&amp;minutes=${m}`)}">Allow for ${m} min</a>`).join('');
  const delay = Math.max(opts.continueAfterSeconds ?? 0, opts.allowAfterSeconds);
  const body = `
<main>
  <p class="kicker">${escapeHtml(status.modeConfig?.label ?? 'Focus')} · ${elapsed} min in</p>
  <h1>${heading}</h1>
  <p class="muted">${reason}</p>
  ${goal}
  ${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ''}
  <div class="row"><a class="btn primary" href="${action('back')}" autofocus>Go back to what I was doing</a>${continueBtn}</div>
  <div class="row">${allowBtns}</div>
  ${delay > 0 ? `<p class="hint muted">More options appear in a few seconds.</p>` : ''}
  <p class="end"><a href="${action('end')}">End the focus session</a></p>
  <p class="url muted">${escapeHtml(iv.url.length > 120 ? iv.url.slice(0, 117) + '…' : iv.url)}</p>
</main>`;
  const styles =
    delayedStyle(opts.continueAfterSeconds ?? 0, 'cont') +
    delayedStyle(opts.allowAfterSeconds, 'allow') +
    (delay > 0 ? `.hint{animation:hide-hint 0s linear ${delay}s forwards}@keyframes hide-hint{to{visibility:hidden}}` : '');
  return page(iv.action === 'warn' ? `Heading to ${iv.site}?` : `${iv.site} is paused`, body, styles);
}

function page(title: string, body: string, extraStyles: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${INTERNAL_PAGE_CSP}">
<title>${escapeHtml(title)}</title><style>${BASE_STYLES}
main{max-width:560px;margin:14vh auto 0;padding:0 24px}
.kicker{color:var(--accent);font-size:13px;letter-spacing:.04em;text-transform:uppercase;margin:0 0 8px}
h1{font-size:26px;font-weight:600;margin:0 0 8px;overflow-wrap:anywhere}
code{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:1px 5px}
.goal{border-left:3px solid var(--accent);padding:4px 12px;margin:20px 0}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.end{margin-top:28px}.end a{color:var(--muted)}
.notice{color:var(--warn)}
.url{font-size:12px;margin-top:40px;overflow-wrap:anywhere}
${extraStyles}</style></head><body>${body}</body></html>`;
}
