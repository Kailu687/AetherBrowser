/**
 * Cleaning / transformation pipelines.
 *
 * A pipeline is a JSON list of steps. Applying it to a dataset version is
 * deterministic (sampling uses a seeded RNG), so the result can be rebuilt
 * from the source file + the step list, and the same list can be exported as
 * pandas code. Each run records rows in/out per step for provenance.
 */
import { type Cell, type Column, type Table, DataError, LIMITS, getColumn, hasColumn, isMissing, num, rowCount, selectRows, uniqueNames } from './table.js';
import { type ColumnType, coerceCell, inferColumn } from './schema.js';
import { evaluate, parseExpr, pyStr, toPandas } from './expr.js';
import { mean, numericValues, quantileSorted, sortedCopy, std } from './stats.js';
import { mulberry32 } from './rng.js';
import { UNSUP_LIMITS, kMeans, pca, standardise } from './ml/unsupervised.js';

export type Agg = 'count' | 'sum' | 'mean' | 'median' | 'min' | 'max' | 'std' | 'nunique' | 'first';

export type Step =
  | { op: 'filter'; expr: string }
  | { op: 'derive'; name: string; expr: string }
  | { op: 'select'; columns: string[] }
  | { op: 'drop'; columns: string[] }
  | { op: 'rename'; from: string; to: string }
  | { op: 'sort'; by: { column: string; desc?: boolean }[] }
  | { op: 'cast'; column: string; type: Exclude<ColumnType, 'empty'> }
  | { op: 'fillMissing'; column: string; strategy: 'mean' | 'median' | 'mode' | 'constant' | 'ffill' | 'bfill'; value?: Cell }
  | { op: 'dropMissing'; columns?: string[] }
  | { op: 'dedupe'; columns?: string[] }
  | { op: 'trim'; columns?: string[] }
  | { op: 'replace'; column: string; from: Cell; to: Cell }
  | { op: 'clipOutliers'; column: string; method: 'iqr' | 'percentile'; lower?: number; upper?: number }
  | { op: 'scale'; column: string; method: 'standard' | 'minmax' }
  | { op: 'oneHot'; column: string; maxCategories?: number }
  | { op: 'groupBy'; by: string[]; aggs: { column: string; agg: Agg; as?: string }[] }
  | { op: 'sample'; n?: number; fraction?: number; seed: number }
  | { op: 'limit'; n: number }
  | { op: 'kmeans'; columns: string[]; k: number; seed: number; as?: string }
  | { op: 'pca'; columns: string[]; components: number; prefix?: string };

export const STEP_OPS = ['filter', 'derive', 'select', 'drop', 'rename', 'sort', 'cast', 'fillMissing', 'dropMissing', 'dedupe', 'trim', 'replace', 'clipOutliers', 'scale', 'oneHot', 'groupBy', 'sample', 'limit', 'kmeans', 'pca'] as const;
export const MAX_STEPS = 200;

export interface StepReport {
  index: number;
  op: Step['op'];
  rowsIn: number;
  rowsOut: number;
  columnsOut: number;
  note?: string;
}

function rowGetter(t: Table, i: number) {
  const byName = new Map(t.columns.map((c) => [c.name, c.values] as const));
  return (name: string): Cell => {
    const v = byName.get(name);
    if (!v) throw new DataError('no-column', `No column named “${name}”.`);
    return v[i];
  };
}

function cols(t: Table, names: string[] | undefined): Column[] {
  return names && names.length ? names.map((n) => getColumn(t, n)) : t.columns;
}

function replaceColumn(t: Table, name: string, values: Cell[]): Table {
  return { columns: t.columns.map((c) => (c.name === name ? { name, values } : c)) };
}

function keyOf(values: Cell[][], i: number): string {
  let s = '';
  for (const v of values) s += (v[i] === null ? '\u0000' : typeof v[i] + ':' + String(v[i])) + '\u0001';
  return s;
}

function aggregate(values: Cell[], agg: Agg): Cell {
  if (agg === 'count') return values.filter((v) => !isMissing(v)).length;
  if (agg === 'nunique') return new Set(values.filter((v) => !isMissing(v)).map(String)).size;
  if (agg === 'first') return values.find((v) => !isMissing(v)) ?? null;
  const xs = numericValues(values);
  if (!xs.length) return null;
  switch (agg) {
    case 'sum':
      return xs.reduce((a, b) => a + b, 0);
    case 'mean':
      return mean(xs);
    case 'median':
      return quantileSorted(sortedCopy(xs), 0.5);
    case 'min':
      return Math.min(...xs);
    case 'max':
      return Math.max(...xs);
    case 'std': {
      const s = std(xs);
      return Number.isFinite(s) ? s : null;
    }
  }
}

function compareCells(a: Cell, b: Cell): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // missing last
  if (b === null) return -1;
  const x = num(a);
  const y = num(b);
  if (!Number.isNaN(x) && !Number.isNaN(y)) return x - y;
  return String(a).localeCompare(String(b));
}

export function applyStep(t: Table, s: Step): { table: Table; note?: string } {
  const n = rowCount(t);
  switch (s.op) {
    case 'filter': {
      const ast = parseExpr(s.expr);
      const keep: number[] = [];
      for (let i = 0; i < n; i++) {
        const v = evaluate(ast, rowGetter(t, i));
        if (v === true || (typeof v === 'number' && v !== 0)) keep.push(i);
      }
      return { table: selectRows(t, keep) };
    }
    case 'derive': {
      const name = s.name.trim().slice(0, LIMITS.maxColumnName);
      if (!name) throw new DataError('step', 'Derived column needs a name.');
      const ast = parseExpr(s.expr);
      const values = new Array<Cell>(n);
      for (let i = 0; i < n; i++) values[i] = evaluate(ast, rowGetter(t, i));
      if (hasColumn(t, name)) return { table: replaceColumn(t, name, values), note: `replaced “${name}”` };
      if (t.columns.length >= LIMITS.maxColumns) throw new DataError('too-many-columns', 'Column limit reached.');
      return { table: { columns: [...t.columns, { name, values }] } };
    }
    case 'select':
      return { table: { columns: s.columns.map((c) => getColumn(t, c)) } };
    case 'drop': {
      for (const c of s.columns) getColumn(t, c);
      return { table: { columns: t.columns.filter((c) => !s.columns.includes(c.name)) } };
    }
    case 'rename': {
      getColumn(t, s.from);
      const to = s.to.trim().slice(0, LIMITS.maxColumnName);
      if (!to) throw new DataError('step', 'New name is empty.');
      if (to !== s.from && hasColumn(t, to)) throw new DataError('step', `A column named “${to}” already exists.`);
      return { table: { columns: t.columns.map((c) => (c.name === s.from ? { name: to, values: c.values } : c)) } };
    }
    case 'sort': {
      const keys = s.by.map((b) => ({ v: getColumn(t, b.column).values, d: b.desc ? -1 : 1 }));
      const idx = Array.from({ length: n }, (_, i) => i);
      idx.sort((a, b) => {
        for (const k of keys) {
          const va = k.v[a];
          const vb = k.v[b];
          if (va === null || vb === null) {
            const c = compareCells(va, vb);
            if (c) return c; // missing always last
            continue;
          }
          const c = compareCells(va, vb) * k.d;
          if (c) return c;
        }
        return a - b; // stable
      });
      return { table: selectRows(t, idx) };
    }
    case 'cast': {
      const c = getColumn(t, s.column);
      let failed = 0;
      const values = c.values.map((v) => {
        const out = coerceCell(v, s.type);
        if (out !== null && (s.type === 'integer' || s.type === 'float') && typeof out !== 'number') {
          failed++;
          return null;
        }
        if (out !== null && s.type === 'boolean' && typeof out !== 'boolean') {
          failed++;
          return null;
        }
        if (s.type === 'integer' && typeof out === 'number') return Math.trunc(out);
        return out;
      });
      return { table: replaceColumn(t, s.column, values), note: failed ? `${failed} values could not be converted and became missing` : undefined };
    }
    case 'fillMissing': {
      const c = getColumn(t, s.column);
      let fill: Cell = s.value ?? null;
      if (s.strategy === 'mean' || s.strategy === 'median') {
        const xs = numericValues(c.values);
        if (!xs.length) throw new DataError('step', `“${s.column}” has no numbers to take a ${s.strategy} from.`);
        fill = s.strategy === 'mean' ? mean(xs) : quantileSorted(sortedCopy(xs), 0.5);
      } else if (s.strategy === 'mode') {
        const m = new Map<string, { v: Cell; n: number }>();
        for (const v of c.values) if (!isMissing(v)) { const k = typeof v + String(v); const e = m.get(k); if (e) e.n++; else m.set(k, { v, n: 1 }); }
        fill = [...m.values()].sort((a, b) => b.n - a.n)[0]?.v ?? null;
      }
      let filled = 0;
      let values: Cell[];
      if (s.strategy === 'ffill' || s.strategy === 'bfill') {
        values = c.values.slice();
        const order = s.strategy === 'ffill' ? values.keys() : [...values.keys()].reverse();
        let last: Cell = null;
        for (const i of order) {
          if (isMissing(values[i])) {
            if (last !== null) { values[i] = last; filled++; }
          } else last = values[i];
        }
      } else {
        values = c.values.map((v) => (isMissing(v) ? (filled++, fill) : v));
      }
      return { table: replaceColumn(t, s.column, values), note: `filled ${filled}${s.strategy !== 'ffill' && s.strategy !== 'bfill' ? ` with ${JSON.stringify(fill)}` : ''}` };
    }
    case 'dropMissing': {
      const cs = cols(t, s.columns);
      const keep: number[] = [];
      for (let i = 0; i < n; i++) if (cs.every((c) => !isMissing(c.values[i]))) keep.push(i);
      return { table: selectRows(t, keep) };
    }
    case 'dedupe': {
      const cs = cols(t, s.columns).map((c) => c.values);
      const seen = new Set<string>();
      const keep: number[] = [];
      for (let i = 0; i < n; i++) {
        const k = keyOf(cs, i);
        if (!seen.has(k)) { seen.add(k); keep.push(i); }
      }
      return { table: selectRows(t, keep) };
    }
    case 'trim': {
      const names = new Set(cols(t, s.columns).map((c) => c.name));
      return { table: { columns: t.columns.map((c) => (names.has(c.name) ? { name: c.name, values: c.values.map((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v)) } : c)) } };
    }
    case 'replace': {
      const c = getColumn(t, s.column);
      let k = 0;
      const values = c.values.map((v) => (v === s.from || (v !== null && s.from !== null && String(v) === String(s.from)) ? (k++, s.to) : v));
      return { table: replaceColumn(t, s.column, values), note: `replaced ${k}` };
    }
    case 'clipOutliers': {
      const c = getColumn(t, s.column);
      const sorted = sortedCopy(numericValues(c.values));
      if (!sorted.length) throw new DataError('step', `“${s.column}” has no numbers.`);
      let lo: number;
      let hi: number;
      if (s.method === 'iqr') {
        const q1 = quantileSorted(sorted, 0.25);
        const q3 = quantileSorted(sorted, 0.75);
        lo = q1 - 1.5 * (q3 - q1);
        hi = q3 + 1.5 * (q3 - q1);
      } else {
        lo = quantileSorted(sorted, (s.lower ?? 1) / 100);
        hi = quantileSorted(sorted, (s.upper ?? 99) / 100);
      }
      let k = 0;
      const values = c.values.map((v) => { const x = num(v); if (Number.isNaN(x)) return v; const y = Math.min(hi, Math.max(lo, x)); if (y !== x) k++; return y; });
      return { table: replaceColumn(t, s.column, values), note: `clipped ${k} to [${+lo.toPrecision(6)}, ${+hi.toPrecision(6)}]` };
    }
    case 'scale': {
      const c = getColumn(t, s.column);
      const xs = numericValues(c.values);
      if (!xs.length) throw new DataError('step', `“${s.column}” has no numbers.`);
      const a = s.method === 'standard' ? mean(xs) : Math.min(...xs);
      const b = s.method === 'standard' ? std(xs) || 1 : Math.max(...xs) - a || 1;
      return { table: replaceColumn(t, s.column, c.values.map((v) => { const x = num(v); return Number.isNaN(x) ? null : (x - a) / b; })), note: `${s.method === 'standard' ? 'mean' : 'min'} ${+a.toPrecision(6)}, ${s.method === 'standard' ? 'std' : 'range'} ${+b.toPrecision(6)} (computed on all rows; fit on training data only for models)` };
    }
    case 'oneHot': {
      const c = getColumn(t, s.column);
      const counts = new Map<string, number>();
      for (const v of c.values) if (!isMissing(v)) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
      const max = Math.min(s.maxCategories ?? 50, 200);
      const cats = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k);
      if (t.columns.length + cats.length > LIMITS.maxColumns) throw new DataError('too-many-columns', 'One-hot encoding would exceed the column limit.');
      const added = cats.map((k) => ({ name: `${s.column}=${k}`, values: c.values.map((v) => (isMissing(v) ? null : String(v) === k ? 1 : 0)) as Cell[] }));
      const rest = t.columns.filter((x) => x.name !== s.column);
      return { table: { columns: uniqueNames([...rest, ...added]) }, note: counts.size > max ? `kept the ${max} most common of ${counts.size} categories; others are all zeros` : undefined };
    }
    case 'groupBy': {
      const keys = s.by.map((b) => getColumn(t, b).values);
      const groups = new Map<string, number[]>();
      for (let i = 0; i < n; i++) {
        const k = keyOf(keys, i);
        const g = groups.get(k);
        if (g) g.push(i); else groups.set(k, [i]);
      }
      const reps = [...groups.values()];
      const out: Column[] = s.by.map((b, j) => ({ name: b, values: reps.map((g) => keys[j][g[0]]) }));
      for (const a of s.aggs) {
        const src = getColumn(t, a.column).values;
        out.push({ name: a.as?.trim() || `${a.agg}(${a.column})`, values: reps.map((g) => aggregate(g.map((i) => src[i]), a.agg)) });
      }
      return { table: { columns: uniqueNames(out) } };
    }
    case 'sample': {
      const k = s.n !== undefined ? Math.min(n, Math.max(0, Math.floor(s.n))) : Math.round(n * Math.min(1, Math.max(0, s.fraction ?? 0.1)));
      const rnd = mulberry32(s.seed >>> 0);
      const idx = Array.from({ length: n }, (_, i) => i);
      for (let i = 0; i < k; i++) {
        const j = i + Math.floor(rnd() * (n - i));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      return { table: selectRows(t, idx.slice(0, k).sort((a, b) => a - b)), note: `seed ${s.seed}` };
    }
    case 'limit':
      return { table: selectRows(t, Array.from({ length: Math.min(n, Math.max(0, Math.floor(s.n))) }, (_, i) => i)) };
    case 'kmeans': {
      const z = standardise(s.columns.map((c) => getColumn(t, c).values.map(num)));
      const r = kMeans(z.X, s.k, s.seed);
      const out = new Array<Cell>(n).fill(null);
      z.rows.forEach((i, k) => (out[i] = r.labels[k]));
      const name = s.as?.trim() || 'cluster';
      const rest = t.columns.filter((c) => c.name !== name);
      const sizes = new Array<number>(s.k).fill(0);
      r.labels.forEach((l) => sizes[l]++);
      return { table: { columns: [...rest, { name, values: out }] }, note: `${s.k} clusters, sizes ${sizes.join('/')}, inertia ${+r.inertia.toPrecision(5)} after ${r.iterations} iterations${z.rows.length < n ? `; ${n - z.rows.length} rows with missing values left blank` : ''} (columns standardised)` };
    }
    case 'pca': {
      const z = standardise(s.columns.map((c) => getColumn(t, c).values.map(num)));
      const r = pca(z.X, s.components);
      const prefix = s.prefix?.trim() || 'PC';
      const added: Column[] = r.explained.map((_, j) => ({ name: `${prefix}${j + 1}`, values: new Array<Cell>(n).fill(null) }));
      z.rows.forEach((i, k) => r.scores[k].forEach((v, j) => (added[j].values[i] = v)));
      const names = new Set(added.map((a) => a.name));
      const rest = t.columns.filter((c) => !names.has(c.name));
      const cum = r.explained.reduce((a, b) => a + b, 0);
      return { table: { columns: [...rest, ...added] }, note: `explained variance ${r.explained.map((e) => `${(e * 100).toFixed(1)}%`).join(', ')} (total ${(cum * 100).toFixed(1)}%; columns standardised, computed on all rows)` };
    }
  }
}

export function runPipeline(t: Table, steps: Step[]): { table: Table; reports: StepReport[] } {
  if (steps.length > MAX_STEPS) throw new DataError('step', `At most ${MAX_STEPS} steps.`);
  let cur = t;
  const reports: StepReport[] = [];
  steps.forEach((s, index) => {
    const rowsIn = rowCount(cur);
    try {
      const r = applyStep(cur, s);
      cur = r.table;
      reports.push({ index, op: s.op, rowsIn, rowsOut: rowCount(cur), columnsOut: cur.columns.length, note: r.note });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new DataError('step', `Step ${index + 1} (${s.op}): ${msg}`);
    }
  });
  return { table: cur, reports };
}

const cols2py = (c: string[]) => `[${c.map(pyStr).join(', ')}]`;

/** pandas code that reproduces the pipeline, for notebooks and reports. */
export function pipelineToPandas(steps: Step[], source: { path?: string; format?: string } = {}): string {
  const lines = ['import numpy as np', 'import pandas as pd', ''];
  const path = pyStr(source.path ?? 'data.csv');
  lines.push(source.format === 'parquet' ? `df = pd.read_parquet(${path})` : source.format === 'json' ? `df = pd.read_json(${path})` : source.format === 'jsonl' ? `df = pd.read_json(${path}, lines=True)` : `df = pd.read_csv(${path})`);
  for (const s of steps) {
    lines.push(`# ${s.op}`);
    switch (s.op) {
      case 'filter': lines.push(`df = df[${toPandas(parseExpr(s.expr))}]`); break;
      case 'derive': lines.push(`df[${pyStr(s.name)}] = ${toPandas(parseExpr(s.expr))}`); break;
      case 'select': lines.push(`df = df[${cols2py(s.columns)}]`); break;
      case 'drop': lines.push(`df = df.drop(columns=${cols2py(s.columns)})`); break;
      case 'rename': lines.push(`df = df.rename(columns={${pyStr(s.from)}: ${pyStr(s.to)}})`); break;
      case 'sort': lines.push(`df = df.sort_values(${cols2py(s.by.map((b) => b.column))}, ascending=[${s.by.map((b) => (b.desc ? 'False' : 'True')).join(', ')}], na_position="last", kind="stable")`); break;
      case 'cast': lines.push(s.type === 'integer' || s.type === 'float' ? `df[${pyStr(s.column)}] = pd.to_numeric(df[${pyStr(s.column)}], errors="coerce")${s.type === 'integer' ? '.astype("Int64")' : ''}` : s.type === 'date' || s.type === 'datetime' ? `df[${pyStr(s.column)}] = pd.to_datetime(df[${pyStr(s.column)}], errors="coerce")` : s.type === 'boolean' ? `df[${pyStr(s.column)}] = df[${pyStr(s.column)}].astype("boolean")` : `df[${pyStr(s.column)}] = df[${pyStr(s.column)}].astype("string")`); break;
      case 'fillMissing': {
        const c = `df[${pyStr(s.column)}]`;
        const fill = s.strategy === 'mean' ? `${c}.mean()` : s.strategy === 'median' ? `${c}.median()` : s.strategy === 'mode' ? `${c}.mode().iloc[0]` : JSON.stringify(s.value ?? null).replace('null', 'np.nan');
        lines.push(s.strategy === 'ffill' ? `${c} = ${c}.ffill()` : s.strategy === 'bfill' ? `${c} = ${c}.bfill()` : `${c} = ${c}.fillna(${fill})`);
        break;
      }
      case 'dropMissing': lines.push(`df = df.dropna(${s.columns?.length ? `subset=${cols2py(s.columns)}` : ''})`); break;
      case 'dedupe': lines.push(`df = df.drop_duplicates(${s.columns?.length ? `subset=${cols2py(s.columns)}` : ''})`); break;
      case 'trim': lines.push(`for c in ${s.columns?.length ? cols2py(s.columns) : 'df.select_dtypes("object").columns'}:\n    df[c] = df[c].str.strip().replace("", np.nan)`); break;
      case 'replace': lines.push(`df[${pyStr(s.column)}] = df[${pyStr(s.column)}].replace(${JSON.stringify(s.from)}, ${JSON.stringify(s.to)})`); break;
      case 'clipOutliers': {
        const c = `df[${pyStr(s.column)}]`;
        lines.push(s.method === 'iqr' ? `q1, q3 = ${c}.quantile([0.25, 0.75])\n${c} = ${c}.clip(q1 - 1.5 * (q3 - q1), q3 + 1.5 * (q3 - q1))` : `${c} = ${c}.clip(${c}.quantile(${(s.lower ?? 1) / 100}), ${c}.quantile(${(s.upper ?? 99) / 100}))`);
        break;
      }
      case 'scale': { const c = `df[${pyStr(s.column)}]`; lines.push(s.method === 'standard' ? `${c} = (${c} - ${c}.mean()) / ${c}.std()` : `${c} = (${c} - ${c}.min()) / (${c}.max() - ${c}.min())`); break; }
      case 'oneHot': lines.push(`df = pd.get_dummies(df, columns=[${pyStr(s.column)}], prefix_sep="=", dtype=int)`); break;
      case 'groupBy': lines.push(`df = df.groupby(${cols2py(s.by)}, dropna=False).agg(**{${s.aggs.map((a) => `${pyStr(a.as?.trim() || `${a.agg}(${a.column})`)}: (${pyStr(a.column)}, ${pyStr(a.agg === 'count' ? 'count' : a.agg)})`).join(', ')}}).reset_index()`); break;
      case 'sample': lines.push(`df = df.sample(${s.n !== undefined ? `n=${s.n}` : `frac=${s.fraction ?? 0.1}`}, random_state=${s.seed}).sort_index()  # note: pandas' RNG differs from AETHER's; rows chosen will differ`); break;
      case 'limit': lines.push(`df = df.head(${s.n})`); break;
      case 'kmeans': lines.push(`from sklearn.cluster import KMeans\nfrom sklearn.preprocessing import StandardScaler\n_cols = ${cols2py(s.columns)}\n_ok = df[_cols].notna().all(axis=1)\ndf.loc[_ok, ${pyStr(s.as?.trim() || 'cluster')}] = KMeans(n_clusters=${s.k}, n_init=1, random_state=${s.seed}).fit_predict(StandardScaler().fit_transform(df.loc[_ok, _cols]))  # cluster numbers may be ordered differently`); break;
      case 'pca': lines.push(`from sklearn.decomposition import PCA\nfrom sklearn.preprocessing import StandardScaler\n_cols = ${cols2py(s.columns)}\n_ok = df[_cols].notna().all(axis=1)\n_pcs = PCA(n_components=${s.components}).fit_transform(StandardScaler().fit_transform(df.loc[_ok, _cols]))  # signs of components may differ\nfor _j in range(_pcs.shape[1]):\n    df.loc[_ok, f"${(s.prefix?.trim() || 'PC').replace(/[^A-Za-z0-9_ ]/g, '')}{_j + 1}"] = _pcs[:, _j]`); break;
    }
  }
  return lines.join('\n') + '\n';
}

/** Validates an untrusted step list (from IPC or an imported file). */
export function validateSteps(input: unknown): Step[] {
  if (!Array.isArray(input)) throw new DataError('bad-request', 'steps must be a list');
  if (input.length > MAX_STEPS) throw new DataError('bad-request', `At most ${MAX_STEPS} steps.`);
  const str = (v: unknown, f: string, max = 2000): string => { if (typeof v !== 'string' || v.length > max) throw new DataError('bad-request', `${f} must be text`); return v; };
  const strs = (v: unknown, f: string): string[] => { if (!Array.isArray(v) || v.length > LIMITS.maxColumns) throw new DataError('bad-request', `${f} must be a list`); return v.map((x) => str(x, f, LIMITS.maxColumnName * 2)); };
  const cell = (v: unknown): Cell => (v === null || v === undefined ? null : typeof v === 'string' ? v.slice(0, LIMITS.maxCellChars) : typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? v : null);
  const n = (v: unknown, f: string): number => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new DataError('bad-request', `${f} must be a number`); return v; };
  return input.map((raw, i): Step => {
    if (!raw || typeof raw !== 'object') throw new DataError('bad-request', `step ${i + 1} is not an object`);
    const s = raw as Record<string, unknown>;
    switch (s.op) {
      case 'filter': return { op: 'filter', expr: str(s.expr, 'expr') };
      case 'derive': return { op: 'derive', name: str(s.name, 'name', LIMITS.maxColumnName), expr: str(s.expr, 'expr') };
      case 'select': return { op: 'select', columns: strs(s.columns, 'columns') };
      case 'drop': return { op: 'drop', columns: strs(s.columns, 'columns') };
      case 'rename': return { op: 'rename', from: str(s.from, 'from'), to: str(s.to, 'to', LIMITS.maxColumnName) };
      case 'sort': if (!Array.isArray(s.by) || s.by.length > 20) throw new DataError('bad-request', 'sort.by'); return { op: 'sort', by: s.by.map((b) => ({ column: str((b as Record<string, unknown>)?.column, 'column'), desc: Boolean((b as Record<string, unknown>)?.desc) })) };
      case 'cast': { const type = s.type as Exclude<ColumnType, 'empty'>; if (!['integer', 'float', 'boolean', 'date', 'datetime', 'categorical', 'text'].includes(type)) throw new DataError('bad-request', 'cast.type'); return { op: 'cast', column: str(s.column, 'column'), type }; }
      case 'fillMissing': { const strategy = s.strategy as 'mean'; if (!['mean', 'median', 'mode', 'constant', 'ffill', 'bfill'].includes(strategy)) throw new DataError('bad-request', 'fillMissing.strategy'); return { op: 'fillMissing', column: str(s.column, 'column'), strategy, value: cell(s.value) }; }
      case 'dropMissing': return { op: 'dropMissing', columns: s.columns === undefined ? undefined : strs(s.columns, 'columns') };
      case 'dedupe': return { op: 'dedupe', columns: s.columns === undefined ? undefined : strs(s.columns, 'columns') };
      case 'trim': return { op: 'trim', columns: s.columns === undefined ? undefined : strs(s.columns, 'columns') };
      case 'replace': return { op: 'replace', column: str(s.column, 'column'), from: cell(s.from), to: cell(s.to) };
      case 'clipOutliers': return { op: 'clipOutliers', column: str(s.column, 'column'), method: s.method === 'percentile' ? 'percentile' : 'iqr', lower: s.lower === undefined ? undefined : Math.min(50, Math.max(0, n(s.lower, 'lower'))), upper: s.upper === undefined ? undefined : Math.min(100, Math.max(50, n(s.upper, 'upper'))) };
      case 'scale': return { op: 'scale', column: str(s.column, 'column'), method: s.method === 'minmax' ? 'minmax' : 'standard' };
      case 'oneHot': return { op: 'oneHot', column: str(s.column, 'column'), maxCategories: s.maxCategories === undefined ? undefined : Math.min(200, Math.max(1, n(s.maxCategories, 'maxCategories'))) };
      case 'groupBy': {
        if (!Array.isArray(s.aggs) || s.aggs.length > 50) throw new DataError('bad-request', 'groupBy.aggs');
        const aggs = s.aggs.map((a) => { const r = a as Record<string, unknown>; const agg = r.agg as Agg; if (!['count', 'sum', 'mean', 'median', 'min', 'max', 'std', 'nunique', 'first'].includes(agg)) throw new DataError('bad-request', 'agg'); return { column: str(r.column, 'column'), agg, as: r.as === undefined ? undefined : str(r.as, 'as', LIMITS.maxColumnName) }; });
        return { op: 'groupBy', by: strs(s.by, 'by'), aggs };
      }
      case 'sample': return { op: 'sample', n: s.n === undefined ? undefined : n(s.n, 'n'), fraction: s.fraction === undefined ? undefined : n(s.fraction, 'fraction'), seed: Math.trunc(n(s.seed ?? 42, 'seed')) };
      case 'limit': return { op: 'limit', n: n(s.n, 'n') };
      case 'kmeans': { const columns = strs(s.columns, 'columns'); if (columns.length > UNSUP_LIMITS.maxColumns) throw new DataError('bad-request', 'too many columns'); return { op: 'kmeans', columns, k: Math.round(Math.min(UNSUP_LIMITS.maxK, Math.max(2, n(s.k ?? 3, 'k')))), seed: Math.trunc(n(s.seed ?? 42, 'seed')), as: s.as === undefined ? undefined : str(s.as, 'as', LIMITS.maxColumnName) }; }
      case 'pca': { const columns = strs(s.columns, 'columns'); if (columns.length > UNSUP_LIMITS.maxColumns) throw new DataError('bad-request', 'too many columns'); return { op: 'pca', columns, components: Math.round(Math.min(columns.length || 1, Math.max(1, n(s.components ?? 2, 'components')))), prefix: s.prefix === undefined ? undefined : str(s.prefix, 'prefix', 40) }; }
      default: throw new DataError('bad-request', `unknown step ${String(s.op).slice(0, 40)}`);
    }
  });
}

export { inferColumn };
