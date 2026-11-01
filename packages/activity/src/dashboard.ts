import { addDays, type ActivityReport } from './reports.js';
import { CATEGORIES, CATEGORY_LABELS, type Category } from './types.js';

export function formatDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (ms > 0 && min === 0) return '<1m';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Categorical slots in fixed order (validated palette); uncategorized is neutral grey. */
const SERIES_VARS: Record<Category, string> = {
  education: 'var(--s1)',
  research: 'var(--s2)',
  productivity: 'var(--s3)',
  communication: 'var(--s4)',
  social: 'var(--s5)',
  entertainment: 'var(--s6)',
  uncategorized: 'var(--s0)',
};

export interface DashboardOptions {
  range: 'today' | 'week';
  profileNames?: Record<string, string>;
  workspaceNames?: Record<string, string>;
  trackingEnabled: boolean;
  paused: boolean;
  baseUrl?: string;
}

export const DASHBOARD_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/** Renders the dashboard as a static, script-free page for aether://activity. */
export function renderDashboardHtml(report: ActivityReport, opts: DashboardOptions): string {
  const base = opts.baseUrl ?? 'aether://activity/';
  const t = report.totals;
  const hasData = t.active + t.passive + t.media > 0;
  const rangeLabel = opts.range === 'today' ? 'Today' : 'Last 7 days';
  const tabs = (['today', 'week'] as const)
    .map((r) => `<a href="${base}?range=${r}" class="tab${r === opts.range ? ' on' : ''}"${r === opts.range ? ' aria-current="page"' : ''}>${r === 'today' ? 'Today' : 'This week'}</a>`)
    .join('');

  const status = !opts.trackingEnabled
    ? `<p class="banner">Activity tracking is off. Nothing new is being recorded. You can turn it on in Settings › Focus &amp; time.</p>`
    : opts.paused
      ? `<p class="banner">Tracking is paused. Time is not being recorded until you resume.</p>`
      : '';

  const tiles = `
<section class="tiles" aria-label="Summary">
  ${tile('Active time', formatDuration(t.active), 'Measured')}
  ${tile('Learning &amp; research', formatDuration(report.learningMs), pct(report.learningMs, t.active))}
  ${tile('Entertainment &amp; social', formatDuration(report.leisureMs), pct(report.leisureMs, t.active))}
  ${tile('Focus sessions', String(report.focusSessions.length), report.focusSessions.length ? `${formatDuration(report.focusedMs)} focused` : 'None yet')}
</section>
<p class="muted small">Also open but not actively used: ${formatDuration(t.passive)} idle in front, ${formatDuration(t.media)} playing media (both inferred).</p>`;

  const body = hasData
    ? `${tiles}
${categoryBar(report)}
${opts.range === 'week' ? weekChart(report) : ''}
${topSites(report)}
${breakdown('By profile', report.byProfile, opts.profileNames ?? {})}
${breakdown('By workspace', report.byWorkspace, opts.workspaceNames ?? {})}
${focusSection(report)}
${interrupters(report)}`
    : `${tiles}<section class="empty"><h2>No browsing recorded ${opts.range === 'today' ? 'today' : 'this week'} yet</h2><p class="muted">Time appears here as you browse. Private windows are never counted.</p></section>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${DASHBOARD_CSP}">
<title>Activity</title><style>${STYLES}</style></head><body><div class="viz-root">
<header><div><p class="kicker">Activity · stored only on this device</p><h1>${rangeLabel}</h1></div><nav class="tabs">${tabs}</nav></header>
${status}
${body}
${methodology()}
<footer class="muted small">Export: <a href="${base}export.csv?range=${opts.range}">CSV</a> · <a href="${base}export.json?range=${opts.range}">JSON</a>. Delete records, exclude sites or set retention in Settings › Focus &amp; time.</footer>
</div></body></html>`;
}

function tile(label: string, value: string, sub: string): string {
  return `<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${esc(value)}</p><p class="tile-sub">${esc(sub)}</p></div>`;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}% of active time` : '—';
}

function legend(cats: Category[]): string {
  return `<ul class="legend">${cats.map((c) => `<li><span class="sw" style="background:${SERIES_VARS[c]}"></span>${esc(CATEGORY_LABELS[c])}</li>`).join('')}</ul>`;
}

function categoryBar(report: ActivityReport): string {
  const total = report.totals.active;
  if (!total) return '';
  const cats = CATEGORIES.filter((c) => report.byCategory[c].active > 0);
  const W = 1000;
  const gap = 2;
  let x = 0;
  const usable = W - gap * (cats.length - 1);
  const rects = cats
    .map((c, i) => {
      const ms = report.byCategory[c].active;
      const w = Math.max(1, (ms / total) * usable);
      const r = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="20" rx="${i === 0 || i === cats.length - 1 ? 4 : 0}" fill="${SERIES_VARS[c]}"><title>${esc(CATEGORY_LABELS[c])}: ${formatDuration(ms)} (${Math.round((ms / total) * 100)}%)</title></rect>`;
      x += w + gap;
      return r;
    })
    .join('');
  const rows = cats
    .sort((a, b) => report.byCategory[b].active - report.byCategory[a].active)
    .map((c) => `<tr><td><span class="sw" style="background:${SERIES_VARS[c]}"></span>${esc(CATEGORY_LABELS[c])}</td><td class="num">${formatDuration(report.byCategory[c].active)}</td><td class="num muted">${Math.round((report.byCategory[c].active / total) * 100)}%</td></tr>`)
    .join('');
  return `<section><h2>Where active time went</h2>
<svg viewBox="0 0 ${W} 20" preserveAspectRatio="none" class="bar" role="img" aria-label="Active time by category">${rects}</svg>
<table class="cats"><tbody>${rows}</tbody></table></section>`;
}

function weekChart(report: ActivityReport): string {
  const days = report.days;
  const max = Math.max(1, ...days.map((d) => CATEGORIES.reduce((n, c) => n + d.activeByCategory[c], 0)));
  const H = 160;
  const colW = 100 / days.length;
  const cats = CATEGORIES.filter((c) => days.some((d) => d.activeByCategory[c] > 0));
  const cols = days
    .map((d, i) => {
      let y = H;
      const x = i * colW + colW * 0.2;
      const w = colW * 0.6;
      const stack = cats
        .filter((c) => d.activeByCategory[c] > 0)
        .map((c) => {
          const h = (d.activeByCategory[c] / max) * (H - 4);
          y -= h;
          const rect = `<rect x="${x.toFixed(2)}" y="${y.toFixed(1)}" width="${w.toFixed(2)}" height="${Math.max(0, h - 2).toFixed(1)}" fill="${SERIES_VARS[c]}"><title>${esc(d.label)} · ${esc(CATEGORY_LABELS[c])}: ${formatDuration(d.activeByCategory[c])}</title></rect>`;
          return rect;
        })
        .join('');
      return stack;
    })
    .join('');
  const labels = days
    .map((d) => `<span>${esc(d.label)}<br><b>${formatDuration(CATEGORIES.reduce((n, c) => n + d.activeByCategory[c], 0))}</b></span>`)
    .join('');
  return `<section><h2>Active time per day</h2>${legend(cats)}
<svg viewBox="0 0 100 ${H}" width="100%" height="${H}" preserveAspectRatio="none" class="week" role="img" aria-label="Active time per day by category"><line x1="0" y1="${H - 0.5}" x2="100" y2="${H - 0.5}" class="axis"/>${cols}</svg>
<div class="daylabels">${labels}</div></section>`;
}

function topSites(report: ActivityReport): string {
  const top = report.byDomain.slice(0, 10);
  if (!top.length) return '';
  const max = Math.max(1, ...top.map((d) => d.active + d.passive + d.media));
  const rows = top
    .map((d) => {
      const all = d.active + d.passive + d.media;
      return `<tr><td class="site"><span class="sw" style="background:${SERIES_VARS[d.category]}" title="${esc(CATEGORY_LABELS[d.category])}"></span>${esc(d.domain)}</td>
<td class="barcell"><div class="bars"><span class="hbar" style="width:${((d.active / max) * 100).toFixed(1)}%;background:${SERIES_VARS[d.category]}"></span><span class="hbar soft" style="width:${(((all - d.active) / max) * 100).toFixed(1)}%"></span></div></td>
<td class="num">${formatDuration(d.active)}</td><td class="num muted">${d.passive + d.media ? '+' + formatDuration(d.passive + d.media) : ''}</td></tr>`;
    })
    .join('');
  return `<section><h2>Most-used sites</h2><table class="sites"><thead><tr><th>Site</th><th class="barcell"></th><th class="num">Active</th><th class="num">Inferred</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function breakdown(title: string, data: Record<string, { active: number; passive: number; media: number }>, names: Record<string, string>): string {
  const entries = Object.entries(data).sort((a, b) => b[1].active - a[1].active);
  if (entries.length < 1 || (entries.length === 1 && title === 'By profile')) return '';
  const rows = entries.map(([id, v]) => `<tr><td>${esc(names[id] ?? id)}</td><td class="num">${formatDuration(v.active)}</td><td class="num muted">${v.passive + v.media ? '+' + formatDuration(v.passive + v.media) : ''}</td></tr>`).join('');
  return `<section class="half"><h2>${title}</h2><table><tbody>${rows}</tbody></table></section>`;
}

function focusSection(report: ActivityReport): string {
  if (!report.focusSessions.length) return '';
  const label: Record<string, string> = { completed: 'Completed', 'ended-by-user': 'Ended early', 'ended-from-intervention': 'Ended at a prompt', 'schedule-ended': 'Schedule ended', replaced: 'Switched mode' };
  const rows = [...report.focusSessions]
    .reverse()
    .map(
      (s) =>
        `<tr><td>${new Date(s.startedAt).toLocaleString('en', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</td><td>${esc(s.goal || s.mode)}</td><td class="num">${formatDuration(s.focusedMs)}</td><td>${esc(label[s.endReason] ?? s.endReason)}</td><td class="num muted">${s.interventions ? `${s.interventions} prompt${s.interventions > 1 ? 's' : ''}` : ''}</td></tr>`,
    )
    .join('');
  return `<section><h2>Focus sessions</h2><table><thead><tr><th>Started</th><th>Goal</th><th class="num">Focused</th><th>Outcome</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function interrupters(report: ActivityReport): string {
  if (!report.interrupters.length) return '';
  const rows = report.interrupters
    .slice(0, 8)
    .map((i) => `<tr><td>${esc(i.domain)}</td><td class="num">${i.attempts}</td><td class="num">${i.wentBack}</td><td class="num">${i.continued}</td></tr>`)
    .join('');
  return `<section><h2>Sites that pulled you away</h2><p class="muted small">Times a focus rule stepped in, and what you chose.</p><table><thead><tr><th>Site</th><th class="num">Prompts</th><th class="num">Went back</th><th class="num">Continued</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function methodology(): string {
  return `<details class="method"><summary>How time is measured</summary>
<p><b>Active</b> (measured): the AETHER window has focus, the tab is the one in front, and you used the keyboard or mouse within the idle threshold.</p>
<p><b>Inferred</b>: time a tab stayed in front after input stopped (capped), and time a tab played audio, such as a lecture, while you were not interacting.</p>
<p>Silent background tabs are never counted. Only the site name and its category are stored, never full addresses, page content, keystrokes or screenshots. Private windows are not recorded. Everything stays on this device.</p>
</details>`;
}

/** Day boundaries helper exported for the shell's date pickers. */
export const nextDay = (dayStart: number): number => addDays(dayStart, 1);

const STYLES = `
.viz-root{--bg:#fcfcfb;--surface:#ffffff;--border:#e3e2dd;--text:#0b0b0b;--muted:#52514e;--grid:#ecebe6;--accent:#2a78d6;
--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s0:#a3a29b;color-scheme:light}
@media (prefers-color-scheme: dark){:root:where(:not([data-theme="light"])) .viz-root{--bg:#1a1a19;--surface:#222221;--border:#353533;--text:#f0efec;--muted:#c3c2b7;--grid:#2c2c2a;--accent:#3987e5;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s0:#6f6e68;color-scheme:dark}}
:root[data-theme="dark"] .viz-root{--bg:#1a1a19;--surface:#222221;--border:#353533;--text:#f0efec;--muted:#c3c2b7;--grid:#2c2c2a;--accent:#3987e5;
--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s0:#6f6e68;color-scheme:dark}
html,body{margin:0}
body{background:#1a1a19}
@media (prefers-color-scheme: light){body{background:#fcfcfb}}
.viz-root{background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif;max-width:920px;margin:0 auto;padding:32px 24px 48px;min-height:100vh;box-sizing:border-box}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
h1{font-size:28px;font-weight:600;margin:0}
h2{font-size:15px;font-weight:600;margin:0 0 10px}
.kicker{margin:0 0 4px;color:var(--muted);font-size:12px;letter-spacing:.04em;text-transform:uppercase}
.tabs{display:flex;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:3px}
.tab{padding:5px 12px;border-radius:6px;color:var(--muted);text-decoration:none}
.tab.on{background:var(--bg);color:var(--text);box-shadow:0 0 0 1px var(--border)}
.tab:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
a{color:var(--accent)}
.banner{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin:20px 0 0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:24px 0 8px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
.tile p{margin:0}.tile-label{color:var(--muted);font-size:12px}.tile-value{font-size:26px;font-weight:600;margin:2px 0}.tile-sub{color:var(--muted);font-size:12px}
section{margin-top:28px}
.muted{color:var(--muted)}.small{font-size:12px}
.bar{width:100%;height:20px;display:block}
.week{display:block;overflow:visible}.axis{stroke:var(--grid);stroke-width:1}
.daylabels{display:flex}.daylabels span{flex:1;text-align:center;font-size:12px;color:var(--muted)}.daylabels b{color:var(--text);font-weight:500}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;list-style:none;padding:0;margin:0 0 10px;font-size:12px;color:var(--muted)}
.sw{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
table{width:100%;border-collapse:collapse}
th{font-weight:500;color:var(--muted);font-size:12px;text-align:left;padding:4px 8px;border-bottom:1px solid var(--border)}
td{padding:6px 8px;border-bottom:1px solid var(--grid);vertical-align:middle}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.cats{margin-top:10px;max-width:420px}
.site{white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}
.barcell{width:45%}
.bars{display:flex;align-items:center}.hbar{display:block;flex:none;height:8px;border-radius:0 4px 4px 0}
.hbar.soft{background:var(--grid);border-radius:0 4px 4px 0;margin-left:2px}
.half{display:inline-block;width:calc(50% - 12px);vertical-align:top;margin-right:12px}
@media (max-width:640px){.half{display:block;width:100%}.barcell{display:none}}
.empty{text-align:center;padding:40px 0}
.method{margin-top:36px;border-top:1px solid var(--border);padding-top:12px;color:var(--muted)}
.method summary{cursor:pointer;color:var(--text)}
footer{margin-top:20px}
`;
