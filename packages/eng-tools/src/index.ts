import { evaluate, parseUnit } from '@aether/calculators';

const BASE = ['m', 'kg', 's', 'A', 'K', 'mol', 'cd', 'bit', 'rad'];

/** SI base-unit form of a unit expression, e.g. "N*m/s" -> "m²·kg·s⁻³". */
export function dimensionString(unit: string): string {
  const { dim } = parseUnit(unit);
  const sup = (n: number) => (n === 1 ? '' : String(n).replace(/-/g, '⁻').replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(d)]));
  const parts = dim.map((p, i) => (Math.abs(p) > 1e-12 ? `${BASE[i]}${sup(Math.round(p * 1000) / 1000)}` : '')).filter(Boolean);
  return parts.length ? parts.join('·') : '1 (dimensionless)';
}

/** Checks that each side of a units equation ("N*m = J", "V/A = ohm") has the same dimension. */
export function checkDimensions(equation: string): { ok: boolean; sides: { unit: string; dims: string }[]; error?: string } {
  const sides = equation.split('=').map((s) => s.trim()).filter(Boolean);
  if (sides.length < 2) return { ok: false, sides: [], error: 'Write it as units on both sides of "=", e.g. kg*m/s^2 = N' };
  try {
    const out = sides.map((u) => ({ unit: u, dims: dimensionString(u) }));
    return { ok: out.every((x) => x.dims === out[0].dims), sides: out };
  } catch (e) {
    return { ok: false, sides: [], error: (e as Error).message };
  }
}

/** Samples y = f(x) for the plotter; non-finite points become gaps (null). */
export function sampleFunction(expr: string, x0: number, x1: number, n = 400): { x: number; y: number | null }[] {
  if (!(x1 > x0)) throw new Error('x max must be greater than x min');
  const pts: { x: number; y: number | null }[] = [];
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    let y: number | null;
    try {
      y = evaluate(expr, new Map([['x', x]]));
      if (!Number.isFinite(y)) y = null;
    } catch (e) {
      if (i === 0 && !(e instanceof RangeError)) {
        // Surface syntax errors once instead of drawing an empty graph.
        try {
          evaluate(expr, new Map([['x', 1]]));
        } catch (err) {
          throw err;
        }
      }
      y = null;
    }
    pts.push({ x, y });
  }
  return pts;
}

export function niceTicks(min: number, max: number, count = 6): number[] {
  const span = max - min || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= step0) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** Developer toolbox helpers (pure, offline). */
export const devtools = {
  json(text: string, indent = 2): string {
    return JSON.stringify(JSON.parse(text), null, indent);
  },
  b64encode(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let s = '';
    bytes.forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s);
  },
  b64decode(text: string): string {
    const s = atob(text.trim());
    return new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  },
  urlEncode: (t: string) => encodeURIComponent(t),
  urlDecode: (t: string) => decodeURIComponent(t),
  timestamp(input: string): { iso: string; unix: number; local: string } {
    const t = input.trim();
    const d = /^\d{9,13}$/.test(t) ? new Date(t.length > 10 ? Number(t) : Number(t) * 1000) : new Date(t || Date.now());
    if (Number.isNaN(d.getTime())) throw new Error('Not a date or Unix timestamp');
    return { iso: d.toISOString(), unix: Math.floor(d.getTime() / 1000), local: d.toLocaleString() };
  },
  async sha256(text: string): Promise<string> {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  },
};
