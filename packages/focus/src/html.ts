export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Internal pages run without scripts; this CSP enforces that. */
export const INTERNAL_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action aether:; base-uri 'none'";

export const BASE_STYLES = `
:root{--bg:#16181b;--surface:#1e2125;--border:#2c3036;--text:#e7e9ec;--muted:#9aa1ab;--accent:#7aa2f7;--accent-text:#0d1220;--warn:#e0af68;color-scheme:dark}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--surface:#fff;--border:#dde1e6;--text:#1b1e22;--muted:#5d6570;--accent:#3557c9;--accent-text:#fff;--warn:#9a6700;color-scheme:light}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 "Segoe UI Variable","Segoe UI",system-ui,sans-serif}
button,.btn{font:inherit;border:1px solid var(--border);background:var(--surface);color:var(--text);border-radius:8px;padding:8px 14px;cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.btn:hover{border-color:var(--muted)}
button:focus-visible,.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.primary{background:var(--accent);color:var(--accent-text);border-color:var(--accent)}
.muted{color:var(--muted)}
`;
