/**
 * Chart data preparation. The main process aggregates (so huge tables never
 * cross IPC); the UI draws the returned series as SVG.
 */
import { type Table, DataError, getColumn, isMissing, num, rowCount } from './table.js';
import { histogram, numericValues, quantileSorted, sortedCopy } from './stats.js';
import { dateValue } from './schema.js';
import { mulberry32 } from './rng.js';

export type ChartKind = 'histogram' | 'bar' | 'line' | 'scatter' | 'box';

export interface ChartRequest {
  kind: ChartKind;
  x: string;
  y?: string;
  /** Aggregation for bar/line when y is given. */
  agg?: 'count' | 'sum' | 'mean';
  /** Colour/group column for scatter and box. */
  group?: string;
  bins?: number;
}

export type ChartData =
  | { kind: 'histogram'; x: string; edges: number[]; counts: number[] }
  | { kind: 'bar'; x: string; y: string; categories: string[]; values: number[]; truncated: boolean }
  | { kind: 'line'; x: string; y: string; xIsDate: boolean; points: [number, number][] }
  | { kind: 'scatter'; x: string; y: string; points: [number, number, string?][]; sampled: boolean; total: number }
  | { kind: 'box'; x: string; groups: { name: string; min: number; q1: number; median: number; q3: number; max: number; n: number }[] };

const MAX_POINTS = 5000;
const MAX_BARS = 40;

export function chartData(t: Table, r: ChartRequest): ChartData {
  const xs = getColumn(t, r.x).values;
  const n = rowCount(t);
  switch (r.kind) {
    case 'histogram': {
      const v = numericValues(xs);
      if (!v.length) throw new DataError('chart', `“${r.x}” has no numbers.`);
      const h = histogram(v, r.bins);
      return { kind: 'histogram', x: r.x, edges: h.edges, counts: h.counts };
    }
    case 'bar': {
      const ys = r.y ? getColumn(t, r.y).values : null;
      const agg = r.y ? r.agg ?? 'sum' : 'count';
      const m = new Map<string, { s: number; c: number }>();
      for (let i = 0; i < n; i++) {
        const k = isMissing(xs[i]) ? '(missing)' : String(xs[i]);
        const e = m.get(k) ?? { s: 0, c: 0 };
        if (ys) { const y = num(ys[i]); if (!Number.isNaN(y)) { e.s += y; e.c++; } } else e.c++;
        m.set(k, e);
      }
      const rows = [...m.entries()].map(([k, e]) => [k, agg === 'count' ? e.c : agg === 'mean' ? (e.c ? e.s / e.c : 0) : e.s] as const).sort((a, b) => b[1] - a[1]);
      return { kind: 'bar', x: r.x, y: r.y ? `${agg}(${r.y})` : 'count', categories: rows.slice(0, MAX_BARS).map((x) => x[0]), values: rows.slice(0, MAX_BARS).map((x) => x[1]), truncated: rows.length > MAX_BARS };
    }
    case 'line': {
      if (!r.y) throw new DataError('chart', 'A line chart needs a Y column.');
      const ys = getColumn(t, r.y).values;
      const xIsDate = numericValues(xs).length < xs.filter((v) => !isMissing(v)).length / 2;
      const m = new Map<number, { s: number; c: number }>();
      for (let i = 0; i < n; i++) {
        const x = xIsDate ? dateValue(xs[i]) : num(xs[i]);
        const y = num(ys[i]);
        if (Number.isNaN(x) || Number.isNaN(y)) continue;
        const e = m.get(x) ?? { s: 0, c: 0 };
        e.s += y; e.c++;
        m.set(x, e);
      }
      let points = [...m.entries()].map(([x, e]) => [x, r.agg === 'sum' ? e.s : e.s / e.c] as [number, number]).sort((a, b) => a[0] - b[0]);
      if (points.length > MAX_POINTS) { const step = points.length / MAX_POINTS; points = Array.from({ length: MAX_POINTS }, (_, i) => points[Math.floor(i * step)]); }
      return { kind: 'line', x: r.x, y: r.y, xIsDate, points };
    }
    case 'scatter': {
      if (!r.y) throw new DataError('chart', 'A scatter plot needs a Y column.');
      const ys = getColumn(t, r.y).values;
      const gs = r.group ? getColumn(t, r.group).values : null;
      let idx: number[] = [];
      for (let i = 0; i < n; i++) if (!Number.isNaN(num(xs[i])) && !Number.isNaN(num(ys[i]))) idx.push(i);
      const total = idx.length;
      if (idx.length > MAX_POINTS) { const rnd = mulberry32(1); idx = idx.filter(() => rnd() < MAX_POINTS / total).slice(0, MAX_POINTS); }
      return { kind: 'scatter', x: r.x, y: r.y, points: idx.map((i) => (gs ? [num(xs[i]), num(ys[i]), String(gs[i] ?? '(missing)')] : [num(xs[i]), num(ys[i])])), sampled: total > idx.length, total };
    }
    case 'box': {
      const gs = r.group ? getColumn(t, r.group).values : null;
      const m = new Map<string, number[]>();
      for (let i = 0; i < n; i++) {
        const x = num(xs[i]);
        if (Number.isNaN(x)) continue;
        const k = gs ? String(gs[i] ?? '(missing)') : r.x;
        (m.get(k) ?? m.set(k, []).get(k)!).push(x);
      }
      const groups = [...m.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 20).map(([name, v]) => { const s = sortedCopy(v); return { name, min: s[0], q1: quantileSorted(s, 0.25), median: quantileSorted(s, 0.5), q3: quantileSorted(s, 0.75), max: s[s.length - 1], n: s.length }; });
      return { kind: 'box', x: r.x, groups };
    }
  }
}
