import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCsv, toCsv, sniffDelimiter, neutraliseFormula } from '../src/csv.js';
import { parseJson, parseJsonLines, flattenRecord } from '../src/jsonio.js';
import { loadDataset } from '../src/io.js';
import { inferSchema, coerceTable } from '../src/schema.js';
import { profileTable } from '../src/profile.js';
import { parseExpr, evaluate, toPandas, EXPR_LIMITS } from '../src/expr.js';
import { runPipeline, pipelineToPandas, validateSteps } from '../src/pipeline.js';
import { chartData } from '../src/charts.js';
import { compareTables } from '../src/compare.js';
import { scanText, luhnValid, verhoeffValid, redactText } from '../src/pii.js';
import { correlationMatrix, quantileSorted, studentTwoSidedP } from '../src/stats.js';
import { FileGuard } from '../src/files.js';
import { getColumn, rowCount, type Table } from '../src/table.js';

const fx = (n: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', n)));

describe('CSV', () => {
  it('parses quotes, embedded newlines, CRLF and BOM', () => {
    const r = parseCsv('﻿name,note,n\r\n"Smith, J","line1\nline2",3\r\nLee,"say ""hi""",4\r\n');
    expect(r.header).toBe(true);
    expect(getColumn(r.table, 'name').values).toEqual(['Smith, J', 'Lee']);
    expect(getColumn(r.table, 'note').values).toEqual(['line1\nline2', 'say "hi"']);
  });
  it('sniffs delimiters and headerless files', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3\n4;5;6')).toBe(';');
    expect(sniffDelimiter('a\tb\n1\t2')).toBe('\t');
    const r = parseCsv('1,2\n3,4\n');
    expect(r.header).toBe(false);
    expect(r.table.columns.map((c) => c.name)).toEqual(['column_1', 'column_2']);
  });
  it('pads ragged rows, dedupes header names, honours maxRows', () => {
    const r = parseCsv('a,a,b\n1,2\n3,4,5,6\n7,8,9\n', { maxRows: 2 });
    expect(r.table.columns.map((c) => c.name)).toEqual(['a', 'a_2', 'b', 'column_4']);
    expect(r.raggedRows).toBe(1);
    expect(r.truncated).toBe(true);
    expect(rowCount(r.table)).toBe(2);
  });
  it('neutralises spreadsheet formulas on export (CSV injection)', () => {
    expect(neutraliseFormula('=HYPERLINK("http://x")')).toBe(`'=HYPERLINK("http://x")`);
    expect(neutraliseFormula('-12.5')).toBe('-12.5');
    expect(neutraliseFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    const out = toCsv({ columns: [{ name: 'x', values: ['=1+1', 'ok', null, -3] }] });
    expect(out).toBe("x\r\n'=1+1\r\nok\r\n\r\n-3\r\n");
  });
});

describe('JSON and Parquet', () => {
  it('reads records, nested paths, columnar and JSON Lines', () => {
    expect(rowCount(parseJson('[{"a":1},{"a":2,"b":{"c":3}}]').table)).toBe(2);
    const nested = parseJson('{"meta":{"n":2},"data":{"items":[{"x":1},{"x":2}]}}');
    expect(nested.path).toBe('data.items');
    expect(parseJson('{"a":[1,2],"b":["x","y"]}').shape).toBe('columns');
    expect(rowCount(parseJsonLines('{"a":1}\n\n{"a":2}\n').table)).toBe(2);
    expect(() => parseJsonLines('{"a":1}\n{bad')).toThrow(/line 2/);
  });
  it('does not pollute prototypes with __proto__ keys', () => {
    const r = parseJson('[{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}}}]');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.table.columns.map((c) => c.name)).toContain('__proto__.polluted');
    const f = flattenRecord(JSON.parse('{"__proto__":{"a":1}}'));
    expect(Object.getPrototypeOf(f)).toBeNull();
  });
  for (const codec of ['snappy', 'gzip', 'zstd', 'none']) {
    it(`reads Parquet (${codec}) written by pyarrow`, async () => {
      const r = await loadDataset(fx(`small-${codec}.parquet`), 'x.parquet');
      expect(r.format).toBe('parquet');
      expect(getColumn(r.table, 'id').values).toEqual([1, 2, 3, 4]);
      expect(getColumn(r.table, 'name').values).toEqual(['a', 'b', null, 'd']);
      expect(getColumn(r.table, 'meta.k').values).toEqual([1, 2, 3, 4]);
      expect(String(getColumn(r.table, 'when').values[1])).toMatch(/^1970-01-02/);
    });
  }
  it('rejects binary junk and non-Parquet bytes', async () => {
    await expect(loadDataset(new Uint8Array([0, 1, 2, 3, 0, 0]), 'x.csv')).rejects.toThrow(/binary/);
    await expect(loadDataset(new TextEncoder().encode('PAR1junk'), 'x.parquet')).rejects.toThrow(/Parquet/);
  });
});

describe('schema and profiling', () => {
  const t = coerceTable(parseCsv('id,age,city,joined,active,email,score\n' + Array.from({ length: 40 }, (_, i) => `${i + 1},${20 + (i % 30)},${['Pune', 'Delhi', ' Goa'][i % 3]},2024-01-${String((i % 28) + 1).padStart(2, '0')},${i % 2 ? 'yes' : 'no'},user${i}@mail.com,${i === 5 ? '' : i * 1.5}`).join('\n')).table);
  it('infers types', () => {
    const s = Object.fromEntries(inferSchema(t).columns.map((c) => [c.name, c.type]));
    expect(s).toMatchObject({ id: 'integer', age: 'integer', city: 'categorical', joined: 'date', active: 'boolean', score: 'float' });
  });
  it('profiles and warns about ids, PII, whitespace and missing values', () => {
    const p = profileTable(t);
    const codes = p.warnings.map((w) => `${w.code}:${w.column ?? ''}`);
    expect(codes).toContain('id:id');
    expect(codes).toContain('pii-email:email');
    expect(codes).toContain('whitespace:city');
    expect(p.profiles.find((c) => c.name === 'score')!.missing).toBe(1);
    expect(p.profiles.find((c) => c.name === 'age')!.numeric!.min).toBe(20);
  });
});

describe('expressions (safe evaluator)', () => {
  const row = (o: Record<string, string | number | null>) => (k: string) => (k in o ? o[k] : (() => { throw new Error('no col ' + k); })());
  it('evaluates arithmetic, logic, strings and functions', () => {
    expect(evaluate(parseExpr('price * qty > 1000 and lower(city) == "pune"'), row({ price: 600, qty: 2, city: 'Pune' }))).toBe(true);
    expect(evaluate(parseExpr('`unit price` * 1.18'), row({ 'unit price': 100 }))).toBeCloseTo(118);
    expect(evaluate(parseExpr('if(isnull(a), 0, a) + 2 ^ 3'), row({ a: null }))).toBe(8);
    expect(evaluate(parseExpr('city in ("Goa", "Pune")'), row({ city: 'Pune' }))).toBe(true);
    expect(evaluate(parseExpr('days_between("2024-01-01", d)'), row({ d: '2024-03-01' }))).toBe(60);
  });
  it('cannot reach JavaScript', () => {
    expect(() => parseExpr('constructor("return process")()')).toThrow(/Unknown function|Unexpected/);
    expect(() => parseExpr('eval("1")')).toThrow(/Unknown function/);
    expect(() => parseExpr('a; b')).toThrow(/Unexpected character/);
    expect(() => parseExpr('('.repeat(200) + '1' + ')'.repeat(200))).toThrow(/nested too deeply/);
    expect(() => parseExpr('1+'.repeat(EXPR_LIMITS.maxLength))).toThrow(/longer/);
    // A column literally named __proto__ is just a column.
    expect(evaluate(parseExpr('`__proto__` + 1'), (k) => (k === '__proto__' ? 1 : null))).toBe(2);
  });
  it('translates to pandas', () => {
    expect(toPandas(parseExpr('a > 1 and lower(b) == "x"'))).toBe('((df["a"] > 1) & (df["b"].str.lower() == "x"))');
  });
});

describe('pipelines', () => {
  const t: Table = { columns: [{ name: 'g', values: ['a', 'a', 'b', 'b', 'b', null] }, { name: 'v', values: [1, null, 3, 4, 100, 6] }, { name: 's', values: [' x ', 'y', 'y', 'z', 'z', 'z'] }] };
  it('runs steps and reports rows per step', () => {
    const { table, reports } = runPipeline(t, validateSteps([
      { op: 'fillMissing', column: 'v', strategy: 'median' },
      { op: 'trim' },
      { op: 'filter', expr: 'notnull(g)' },
      { op: 'derive', name: 'v2', expr: 'v * 2' },
      { op: 'groupBy', by: ['g'], aggs: [{ column: 'v', agg: 'sum' }, { column: 'v', agg: 'count', as: 'n' }] },
      { op: 'sort', by: [{ column: 'g', desc: true }] },
    ]));
    expect(reports.map((r) => r.rowsOut)).toEqual([6, 6, 5, 5, 2, 2]);
    expect(getColumn(table, 'g').values).toEqual(['b', 'a']);
    expect(getColumn(table, 'sum(v)').values).toEqual([107, 5]);
    expect(getColumn(table, 'n').values).toEqual([3, 2]);
  });
  it('one-hot, clip, dedupe, sample (seeded)', () => {
    expect(runPipeline(t, [{ op: 'oneHot', column: 's' }]).table.columns.map((c) => c.name)).toContain('s=z');
    expect(Math.max(...(getColumn(runPipeline(t, [{ op: 'clipOutliers', column: 'v', method: 'iqr' }]).table, 'v').values.filter((x) => x !== null) as number[]))).toBeLessThan(100);
    expect(rowCount(runPipeline(t, [{ op: 'dedupe', columns: ['s'] }]).table)).toBe(3);
    const a = runPipeline(t, [{ op: 'sample', n: 3, seed: 5 }]).table;
    const b = runPipeline(t, [{ op: 'sample', n: 3, seed: 5 }]).table;
    expect(a).toEqual(b);
  });
  it('names the failing step and validates untrusted step lists', () => {
    expect(() => runPipeline(t, [{ op: 'filter', expr: 'missing_col > 1' }])).toThrow(/Step 1 \(filter\).*missing_col/);
    expect(() => validateSteps([{ op: 'rm -rf' }])).toThrow(/unknown step/);
    expect(() => validateSteps('x')).toThrow();
  });
  it('exports pandas code', () => {
    const code = pipelineToPandas([{ op: 'filter', expr: 'v > 2' }, { op: 'dropMissing' }], { path: 'data.csv' });
    expect(code).toContain('df = df[(df["v"] > 2)]');
    expect(code).toContain('df = df.dropna()');
  });
});

describe('charts, correlation, compare, stats', () => {
  const t: Table = { columns: [{ name: 'x', values: [1, 2, 3, 4, 5, 6] }, { name: 'y', values: [2, 4, 6, 8, 10, 12] }, { name: 'c', values: ['a', 'b', 'a', 'b', 'a', 'a'] }] };
  it('builds chart data', () => {
    expect(chartData(t, { kind: 'bar', x: 'c' })).toMatchObject({ categories: ['a', 'b'], values: [4, 2] });
    const box = chartData(t, { kind: 'box', x: 'x', group: 'c' });
    expect(box.kind === 'box' && box.groups[0].n).toBe(4);
    expect(chartData(t, { kind: 'histogram', x: 'x' }).kind).toBe('histogram');
  });
  it('correlation and quantiles match known values', () => {
    expect(correlationMatrix(t, ['x', 'y']).values[0][1]).toBeCloseTo(1);
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(studentTwoSidedP(2.228, 10)).toBeCloseTo(0.05, 2);
  });
  it('compares versions: schema, rows by key and drift', () => {
    const b: Table = { columns: [{ name: 'x', values: [1, 2, 3, 4, 5, 7] }, { name: 'y', values: [2, 4, 6, 9, 10, 14] }, { name: 'z', values: [0, 0, 0, 0, 0, 0] }] };
    const c = compareTables(t, b, { key: ['x'] });
    expect(c.schema.map((s) => `${s.change}:${s.column}`).sort()).toEqual(['added:z', 'removed:c']);
    expect(c.rows).toMatchObject({ added: 1, removed: 1, changed: 1, unchanged: 4 });
  });
});

describe('sensitive data', () => {
  it('uses checksums so random numbers are not flagged', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(verhoeffValid('234123412346')).toBe(true);
    expect(verhoeffValid('234123412345')).toBe(false);
    const kinds = scanText('mail me at a.b@x.org, card 4111 1111 1111 1111, PAN ABCPE1234F, key sk-ant-abcdefghijklmnopqrstuvwx, order 123456789012').map((f) => f.kind).sort();
    expect(kinds).toEqual(['api-key', 'card', 'email', 'pan']);
  });
  it('redacts for prompts', () => {
    expect(redactText('reach me: +91 98765 43210').text).toContain('[PHONE]');
  });
});

describe('file guard', () => {
  it('only allows picked files, granted folders and dataDir; no traversal or symlink escape', async () => {
    const base = mkdtempSync(join(tmpdir(), 'guard-'));
    const data = join(base, 'data');
    const granted = join(base, 'granted');
    const secret = join(base, 'secret.txt');
    mkdirSync(data); mkdirSync(granted);
    writeFileSync(secret, 'top secret');
    writeFileSync(join(granted, 'ok.csv'), 'a\n1');
    symlinkSync(secret, join(granted, 'link.csv'));
    const g = new FileGuard(data);
    expect(() => g.check(join(granted, 'ok.csv'))).toThrow(/only open files you picked/);
    g.grantFolder(granted);
    expect((await g.read(join(granted, 'ok.csv'))).bytes.length).toBe(3);
    expect(() => g.check(join(granted, '..', 'secret.txt'))).toThrow(/only open/);
    await expect(g.read(join(granted, 'link.csv'))).rejects.toThrow(/only open/);
    expect(() => g.check('relative/path.csv')).toThrow(/absolute/);
    expect(() => g.check(join(granted, 'a\0b'))).toThrow(/Invalid/);
    expect(() => g.inData('..', 'x')).toThrow(/Bad file name/);
    expect(() => g.grantFolder('/')).toThrow(/whole drive/);
  });
});
