import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { evaluate, PROJECT_MIGRATIONS, ProjectStore, projectReport, rollup, toBase } from '../src/index.js';

function store() {
  const db = new DatabaseSync(':memory:');
  for (const m of PROJECT_MIGRATIONS) db.exec(m.up);
  return new ProjectStore(db as never);
}

describe('requirement evaluation', () => {
  it('compares across SI prefixes and refuses mismatched units', () => {
    expect(toBase(500, 'mA')).toEqual({ value: 0.5, unit: 'A' });
    expect(evaluate({ operator: '>=', target: 0.5, target2: null, unit: 'A' }, 800, 'mA')).toBe('satisfied');
    expect(evaluate({ operator: '<=', target: 3.6, target2: null, unit: 'V' }, 5, 'V')).toBe('violated');
    expect(evaluate({ operator: '<=', target: 3.6, target2: null, unit: 'V' }, 5, 'A')).toBe('unknown');
    expect(evaluate({ operator: 'between', target: -40, target2: 85, unit: '°C' }, 25, '°C')).toBe('satisfied');
    expect(evaluate({ operator: '>=', target: 1, target2: null, unit: 'A' }, null, 'A')).toBe('unknown');
  });
  it('rollup needs measured/reviewed/verified, current evidence to call a requirement satisfied', () => {
    const v = (status: 'satisfied' | 'violated' | 'unknown', evidence: string, stale = false) => ({ status, evidence, stale }) as never;
    expect(rollup([v('satisfied', 'simulated')])).toBe('unknown');
    expect(rollup([v('satisfied', 'calculated')])).toBe('unknown');
    expect(rollup([v('satisfied', 'measured')])).toBe('satisfied');
    expect(rollup([v('satisfied', 'verified', true)])).toBe('unknown');
    expect(rollup([v('satisfied', 'verified'), v('violated', 'proposed')])).toBe('violated');
  });
});

describe('project store', () => {
  it('keeps projects per profile and links items, tasks, decisions and evidence', () => {
    const st = store();
    const p = st.create('a', { name: 'Drone FC' });
    expect(st.list('b')).toHaveLength(0);
    expect(() => st.get('b', p.id)).toThrow();
    const it1 = st.addItem('a', p.id, { kind: 'tab', title: 'LDO datasheet', ref: 'https://example.com/ldo.pdf', app: null });
    expect(st.addItem('a', p.id, { kind: 'tab', title: 'dup', ref: 'https://example.com/ldo.pdf', app: null }).id).toBe(it1.id);
    st.addTask('a', p.id, 'Pick regulator');
    st.addDecision('a', p.id, { title: 'Use AMS1117-3.3', rationale: 'Cheap and available', itemIds: [it1.id] });
    const r = st.addRequirement('a', p.id, { name: '3V3 rail current', parameter: 'Output current', operator: '>=', target: 800, target2: null, unit: 'mA', notes: '' });
    const v = st.addValidation('a', p.id, r.id, { value: 1, unit: 'A', source: 'datasheet', sourceRef: 'AMS1117 datasheet p.2', sourceItemId: it1.id, verified: true });
    expect(v.status).toBe('satisfied');
    const g = st.get('a', p.id);
    expect(g.requirements[0].status).toBe('satisfied');
    expect(st.list('a')[0].counts).toEqual({ items: 1, open: 1 });
    const md = projectReport(g);
    expect(md).toContain('3V3 rail current — SATISFIED');
    expect(md).toContain('AMS1117 datasheet p.2');
    st.delete('a', p.id);
    expect(st.list('a')).toHaveLength(0);
  });
  it('traces changes: links, impact, stale evidence and archive round-trip', () => {
    const st = store();
    const p = st.create('a', { name: 'FC board' });
    const mcu = st.addItem('a', p.id, { kind: 'document', title: 'STM32F103 datasheet', ref: 'https://st.com/f103.pdf', app: null });
    const fw = st.addItem('a', p.id, { kind: 'code', title: 'firmware/clock.c', ref: 'file:///fw/clock.c', app: 'code' });
    const r = st.addRequirement('a', p.id, { name: 'Core clock', parameter: 'SYSCLK', operator: '>=', target: 72, target2: null, unit: 'MHz', notes: '' });
    const v = st.addValidation('a', p.id, r.id, { value: 72, unit: 'MHz', source: 'datasheet', sourceRef: 'p.12', sourceItemId: mcu.id, evidence: 'reviewed' });
    expect(st.get('a', p.id).requirements[0].status).toBe('satisfied');
    st.link('a', p.id, `item:${mcu.id}`, `item:${fw.id}`, 'clock tree');
    expect(() => st.link('a', p.id, `item:${mcu.id}`, 'item:nope')).toThrow();
    expect(st.impact('a', p.id, `item:${mcu.id}`).sort()).toEqual([`item:${fw.id}`, `req:${r.id}`].sort());
    const c = st.recordChange('a', p.id, { ref: `item:${mcu.id}`, summary: 'MCU changed to STM32G431' });
    expect(c.impacted).toContain(`req:${r.id}`);
    const g = st.get('a', p.id);
    expect(g.requirements[0].validations[0].stale).toBe(true);
    expect(g.requirements[0].status).toBe('unknown');
    expect(g.changes).toHaveLength(1);
    st.confirmValidation('a', p.id, v.id);
    expect(st.get('a', p.id).requirements[0].status).toBe('satisfied');
    expect(st.search('a', 'clock').map((x) => x.kind)).toEqual(expect.arrayContaining(['code', 'requirement']));
    const copy = st.importProject('a', JSON.parse(JSON.stringify(st.exportProject('a', p.id))));
    const cg = st.get('a', copy.id);
    expect(cg.items).toHaveLength(2);
    expect(cg.links).toHaveLength(1);
    expect(cg.requirements[0].validations[0].sourceItemId).toBe(cg.items.find((i) => i.title.startsWith('STM32'))!.id);
    expect(() => st.importProject('a', { format: 'x' })).toThrow();
  });
});
