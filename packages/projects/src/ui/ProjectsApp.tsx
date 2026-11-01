import { useCallback, useEffect, useState } from 'react';
import type { WorkbenchAppApi } from '@aether/plugin-api';
import type { Evidence, ProjectStore, Status } from '../model.js';

type Full = ReturnType<ProjectStore['get']>;
type Summary = Awaited<ReturnType<ProjectStore['list']>>[number];
type Tab = 'overview' | 'requirements' | 'tasks' | 'decisions' | 'changes';
const EVIDENCE: Evidence[] = ['proposed', 'calculated', 'simulated', 'measured', 'reviewed', 'verified'];
const PROVING = new Set<Evidence>(['measured', 'reviewed', 'verified']);

const KIND_ICON: Record<string, string> = { tab: '🌐', source: '📚', document: '📝', code: '⌨️', schematic: '🔌', dataset: '📊', note: '🗒', file: '📄', result: '📈', link: '🔗' };
const STATUS: Record<Status, { label: string; cls: string }> = { satisfied: { label: 'Satisfied', cls: 'ok' }, violated: { label: 'Violated', cls: 'bad' }, unknown: { label: 'Unknown', cls: 'unk' } };

export function ProjectsApp({ api }: { api: WorkbenchAppApi }) {
  const [list, setList] = useState<Summary[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const [data, setData] = useState<Full | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    const l = await api.invoke<Summary[]>('list');
    setList(l);
    const id = cur ?? l[0]?.id ?? null;
    if (id !== cur) setCur(id);
    setData(id ? await api.invoke<Full>('get', { id }) : null);
  }, [api, cur]);
  useEffect(() => {
    void load();
    return api.on('changed', () => void load());
  }, [api, load]);
  const call = async (method: string, payload: Record<string, unknown>) => {
    setMsg('');
    try {
      await api.invoke(method, { projectId: cur, ...payload });
    } catch (e) {
      setMsg(e instanceof Error ? e.message.replace(/^Error invoking remote method[^:]*: (Error: )?/, '') : String(e));
    }
  };
  const create = async () => {
    const p = await api.invoke<{ id: string }>('create', { name: `Project ${list.length + 1}` });
    setCur(p.id);
  };
  return (
    <div className="wb-split-view pj">
      <aside className="wb-side">
        <h5>Projects</h5>
        {list.map((p) => (
          <button key={p.id} className={`wb-side-item ${p.id === cur ? 'on' : ''}`} onClick={() => setCur(p.id)}>
            <span className="pj-dot" style={{ background: p.color }} /> {p.name}
            <small className="muted"> · {p.counts.items} items{p.counts.open ? ` · ${p.counts.open} open tasks` : ''}</small>
          </button>
        ))}
        <div style={{ padding: 10 }}>
          <button className="wb-btn primary" onClick={() => void create()}>
            + New project
          </button>
        </div>
      </aside>
      <main className="wb-content">
        {!data && <Empty onCreate={() => void create()} />}
        {data && (
          <>
            <header className="pj-head">
              <input className="pj-name" value={data.project.name} onChange={(e) => setData({ ...data, project: { ...data.project, name: e.target.value } })} onBlur={(e) => void api.invoke('update', { id: data.project.id, name: e.target.value })} />
              <span className="grow" />
              <button className="wb-btn" title="Save the address of the page you are reading into this project" onClick={() => void call('addActiveTab', {})}>
                + Add current tab
              </button>
              <button
                className="wb-btn"
                onClick={async () => {
                  const md = await api.invoke<string>('report', { id: data.project.id });
                  const doc = await api.invokeModule<{ id: string }>('aether.writer', 'createFromMarkdown', { title: `${data.project.name} — project report`, markdown: md, template: 'report' });
                  api.openApp('writer', doc.id);
                }}
              >
                Report → Writer
              </button>
              <button className="wb-btn danger" onClick={() => confirm(`Delete “${data.project.name}” and its records? Linked documents and files are not deleted.`) && void api.invoke('delete', { id: data.project.id }).then(() => setCur(null))}>
                Delete
              </button>
            </header>
            <textarea className="wb-input pj-desc" placeholder="What is this project about? Goals, constraints, deadlines…" defaultValue={data.project.description} key={data.project.id} onBlur={(e) => void api.invoke('update', { id: data.project.id, description: e.target.value })} />
            {msg && <p className="danger small">{msg}</p>}
            <nav className="pj-tabs">
              {(['overview', 'requirements', 'tasks', 'decisions', 'changes'] as Tab[]).map((t) => (
                <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                  {{ overview: `Materials (${data.items.length})`, requirements: `Requirements (${data.requirements.length})`, tasks: `Tasks (${data.tasks.filter((x) => x.status !== 'done').length})`, decisions: `Decisions (${data.decisions.length})`, changes: `Changes & links (${data.changes.length})` }[t]}
                </button>
              ))}
            </nav>
            {tab === 'overview' && <Materials data={data} api={api} call={call} />}
            {tab === 'requirements' && <Requirements data={data} call={call} />}
            {tab === 'tasks' && <Tasks data={data} call={call} />}
            {tab === 'decisions' && <Decisions data={data} call={call} />}
            {tab === 'changes' && <Changes data={data} api={api} call={call} />}
          </>
        )}
      </main>
    </div>
  );
}

function Empty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="pj-empty">
      <h2>Projects</h2>
      <p className="muted">Keep everything for one piece of work together: the tabs you are reading, sources, Writer documents, code, schematics and results, plus tasks, design decisions and requirement checks that show which specs are satisfied, violated or still unknown.</p>
      <button className="wb-btn primary" onClick={onCreate}>
        Create your first project
      </button>
    </div>
  );
}

function Materials({ data, api, call }: { data: Full; api: WorkbenchAppApi; call: (m: string, p: Record<string, unknown>) => Promise<void> }) {
  const [docs, setDocs] = useState<{ id: string; title: string }[]>([]);
  const [url, setUrl] = useState('');
  useEffect(() => void api.invokeModule<{ id: string; title: string }[]>('aether.writer', 'list').then(setDocs).catch(() => setDocs([])), [api]);
  const open = (i: Full['items'][number]) => {
    if (i.kind === 'document') api.openApp('writer', i.ref);
    else if (i.app) api.openApp(i.app, i.ref);
    else void api.invoke('openItem', { ref: i.ref });
  };
  const groups = new Map<string, Full['items']>();
  for (const i of data.items) groups.set(i.kind, [...(groups.get(i.kind) ?? []), i]);
  return (
    <div>
      <div className="row pj-add">
        <input className="wb-input grow" placeholder="Paste a link to add (https://…)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="wb-btn" disabled={!/^https?:\/\//.test(url)} onClick={() => void call('addItem', { kind: 'link', title: url, ref: url }).then(() => setUrl(''))}>
          Add link
        </button>
        <select className="wb-select" value="" onChange={(e) => e.target.value && void call('addItem', { kind: 'document', title: docs.find((d) => d.id === e.target.value)?.title ?? 'Document', ref: e.target.value, app: 'writer' })}>
          <option value="">Add a Writer document…</option>
          {docs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      </div>
      {!data.items.length && <p className="muted small">Nothing here yet. Add the tab you are reading, a link, or a document. Modules (Electronics & ECE, Research & Writing…) can add their schematics and results here too.</p>}
      {[...groups].map(([kind, items]) => (
        <section key={kind}>
          <h5 className="pj-h5">
            {KIND_ICON[kind]} {kind}
          </h5>
          {items.map((i) => (
            <div key={i.id} className="list-row pj-item">
              <button className="wb-link grow ellipsis" title={i.ref} onClick={() => open(i)}>
                {i.title}
              </button>
              <small className="muted">{new Date(i.addedAt).toLocaleDateString()}</small>
              <button className="wb-icon small" title="Remove from project" onClick={() => void call('removeItem', { itemId: i.id })}>
                ✕
              </button>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function Requirements({ data, call }: { data: Full; call: (m: string, p: Record<string, unknown>) => Promise<void> }) {
  const [f, setF] = useState({ name: '', parameter: '', operator: '<=', target: '', target2: '', unit: '' });
  const [ev, setEv] = useState<Record<string, { value: string; unit: string; source: string; sourceRef: string; evidence: Evidence; sourceItemId: string }>>({});
  return (
    <div>
      <p className="small muted">
        A requirement is <b>satisfied</b> only when current measured, reviewed or verified evidence meets it. Any current evidence that breaks it marks it <b>violated</b>; otherwise it stays <b>unknown</b>. Proposals, calculations and simulations are shown but are never proof. Evidence turns <b>stale</b> when the thing it came from changes.
      </p>
      <table className="wb-table">
        <thead>
          <tr>
            <th>Requirement</th>
            <th>Target</th>
            <th>Status</th>
            <th>Evidence (where each number came from)</th>
          </tr>
        </thead>
        <tbody>
          {data.requirements.map((r) => {
            const e = ev[r.id] ?? { value: '', unit: r.unit, source: 'measurement', sourceRef: '', evidence: 'measured' as Evidence, sourceItemId: '' };
            return (
              <tr key={r.id}>
                <td>
                  <b>{r.name}</b>
                  <div className="small muted">{r.parameter}</div>
                  <button className="wb-link small" onClick={() => void call('deleteRequirement', { id: r.id })}>
                    remove
                  </button>
                </td>
                <td className="mono">{r.operator === 'between' ? `${r.target} … ${r.target2} ${r.unit}` : `${r.operator} ${r.target} ${r.unit}`}</td>
                <td>
                  <span className={`pj-status ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                </td>
                <td>
                  {r.validations.map((v) => (
                    <div key={v.id} className={`small pj-ev ${v.stale ? 'stale' : ''}`}>
                      <span className={`pj-status mini ${STATUS[v.status].cls}`}>{STATUS[v.status].label}</span> {v.value ?? '?'} {v.unit} · {v.source}
                      {v.sourceRef && <> · {v.sourceRef}</>}
                      {v.sourceItemId && <> · from {data.items.find((i) => i.id === v.sourceItemId)?.title ?? 'removed item'}</>}{' '}
                      <select className={`pj-evlevel ${PROVING.has(v.evidence) ? 'proving' : ''}`} title="How far this evidence has got. Only you can mark it reviewed or verified." value={v.evidence} onChange={(x) => void call('setEvidence', { id: v.id, evidence: x.target.value })}>
                        {EVIDENCE.map((l) => (
                          <option key={l}>{l}</option>
                        ))}
                      </select>
                      {v.stale && (
                        <span className="pj-stale" title={v.staleReason ?? ''}>
                          stale: {v.staleReason}{' '}
                          <button className="wb-link small" onClick={() => void call('confirmValidation', { id: v.id })}>
                            still valid
                          </button>
                        </span>
                      )}
                      <button className="wb-icon small" onClick={() => void call('deleteValidation', { id: v.id })}>
                        ✕
                      </button>
                    </div>
                  ))}
                  <div className="row pj-evform">
                    <input className="wb-input" style={{ width: 70 }} placeholder="value" value={e.value} onChange={(x) => setEv({ ...ev, [r.id]: { ...e, value: x.target.value } })} />
                    <input className="wb-input" style={{ width: 50 }} placeholder="unit" value={e.unit} onChange={(x) => setEv({ ...ev, [r.id]: { ...e, unit: x.target.value } })} />
                    <select className="wb-select" value={e.source} onChange={(x) => setEv({ ...ev, [r.id]: { ...e, source: x.target.value } })}>
                      {['measurement', 'datasheet', 'simulation', 'calculation', 'other'].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                    <input className="wb-input grow" placeholder="source (page, file, test id)" value={e.sourceRef} onChange={(x) => setEv({ ...ev, [r.id]: { ...e, sourceRef: x.target.value } })} />
                    <select className="wb-select" title="From which project material" value={e.sourceItemId} onChange={(x) => setEv({ ...ev, [r.id]: { ...e, sourceItemId: x.target.value } })}>
                      <option value="">no linked material</option>
                      {data.items.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.title.slice(0, 40)}
                        </option>
                      ))}
                    </select>
                    <select className="wb-select" value={e.evidence} onChange={(x) => setEv({ ...ev, [r.id]: { ...e, evidence: x.target.value as Evidence } })}>
                      {EVIDENCE.slice(0, 4).map((l) => (
                        <option key={l}>{l}</option>
                      ))}
                    </select>
                    <button
                      className="wb-btn small"
                      onClick={() =>
                        void call('addValidation', { requirementId: r.id, value: e.value === '' ? null : Number(e.value), unit: e.unit, source: e.source, sourceRef: e.sourceRef, evidence: e.evidence, ...(e.sourceItemId ? { sourceItemId: e.sourceItemId } : {}) }).then(() =>
                          setEv({ ...ev, [r.id]: { ...e, value: '', sourceRef: '' } }),
                        )
                      }
                    >
                      Add
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h5 className="pj-h5">New requirement</h5>
      <div className="row pj-reqform">
        <input className="wb-input" placeholder="Name (e.g. 3V3 rail current)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className="wb-input" placeholder="Parameter (e.g. output current)" value={f.parameter} onChange={(e) => setF({ ...f, parameter: e.target.value })} />
        <select className="wb-select" value={f.operator} onChange={(e) => setF({ ...f, operator: e.target.value })}>
          {['<=', '>=', '<', '>', '=', 'between'].map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <input className="wb-input" style={{ width: 80 }} placeholder="target" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} />
        {f.operator === 'between' && <input className="wb-input" style={{ width: 80 }} placeholder="max" value={f.target2} onChange={(e) => setF({ ...f, target2: e.target.value })} />}
        <input className="wb-input" style={{ width: 60 }} placeholder="unit" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} />
        <button
          className="wb-btn primary"
          disabled={!f.name || f.target === '' || Number.isNaN(Number(f.target))}
          onClick={() => void call('addRequirement', { ...f, target: Number(f.target), target2: f.target2 === '' ? null : Number(f.target2) }).then(() => setF({ name: '', parameter: '', operator: '<=', target: '', target2: '', unit: '' }))}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function Tasks({ data, call }: { data: Full; call: (m: string, p: Record<string, unknown>) => Promise<void> }) {
  const [t, setT] = useState('');
  const cols: ['todo' | 'doing' | 'done', string][] = [
    ['todo', 'To do'],
    ['doing', 'Doing'],
    ['done', 'Done'],
  ];
  return (
    <div>
      <div className="row pj-add">
        <input className="wb-input grow" placeholder="New task" value={t} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && t && void call('addTask', { title: t }).then(() => setT(''))} />
        <button className="wb-btn" disabled={!t} onClick={() => void call('addTask', { title: t }).then(() => setT(''))}>
          Add
        </button>
      </div>
      <div className="pj-board">
        {cols.map(([st, label]) => (
          <div key={st} className="pj-col">
            <h5 className="pj-h5">{label}</h5>
            {data.tasks
              .filter((x) => x.status === st)
              .map((x) => (
                <div key={x.id} className="wb-card pj-task">
                  <span className={st === 'done' ? 'pj-done' : ''}>{x.title}</span>
                  <div className="row">
                    {cols
                      .filter(([s2]) => s2 !== st)
                      .map(([s2, l2]) => (
                        <button key={s2} className="wb-btn small" onClick={() => void call('setTask', { taskId: x.id, status: s2 })}>
                          → {l2}
                        </button>
                      ))}
                    <button className="wb-icon small" onClick={() => void call('deleteTask', { taskId: x.id })}>
                      ✕
                    </button>
                  </div>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Decisions({ data, call }: { data: Full; call: (m: string, p: Record<string, unknown>) => Promise<void> }) {
  const [f, setF] = useState({ title: '', rationale: '', alternatives: '', itemIds: [] as string[] });
  return (
    <div>
      {data.decisions.map((d) => (
        <div key={d.id} className="wb-card pj-dec">
          <div className="row">
            <b className="grow">{d.title}</b>
            <small className="muted">{new Date(d.decidedAt).toLocaleDateString()}</small>
            <button className="wb-icon small" onClick={() => void call('deleteDecision', { id: d.id })}>
              ✕
            </button>
          </div>
          <p className="small">{d.rationale}</p>
          {d.alternatives && <p className="small muted">Alternatives: {d.alternatives}</p>}
          {!!d.itemIds.length && <p className="small muted">Based on: {d.itemIds.map((id) => data.items.find((i) => i.id === id)?.title ?? 'removed item').join(' · ')}</p>}
        </div>
      ))}
      <h5 className="pj-h5">Record a decision</h5>
      <div className="pj-decform">
        <input className="wb-input" placeholder="Decision (e.g. Use ESP32-S3 instead of STM32)" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <textarea className="wb-input" rows={3} placeholder="Why? (evidence, trade-offs)" value={f.rationale} onChange={(e) => setF({ ...f, rationale: e.target.value })} />
        <input className="wb-input" placeholder="Alternatives considered" value={f.alternatives} onChange={(e) => setF({ ...f, alternatives: e.target.value })} />
        {!!data.items.length && (
          <div className="small">
            Based on:{' '}
            {data.items.slice(0, 20).map((i) => (
              <label key={i.id} className="pj-chip">
                <input type="checkbox" checked={f.itemIds.includes(i.id)} onChange={(e) => setF({ ...f, itemIds: e.target.checked ? [...f.itemIds, i.id] : f.itemIds.filter((x) => x !== i.id) })} /> {i.title.slice(0, 40)}
              </label>
            ))}
          </div>
        )}
        <button className="wb-btn primary" disabled={!f.title || !f.rationale} onClick={() => void call('addDecision', f).then(() => setF({ title: '', rationale: '', alternatives: '', itemIds: [] }))}>
          Save decision
        </button>
      </div>
    </div>
  );
}

function Changes({ data, api, call }: { data: Full; api: WorkbenchAppApi; call: (m: string, p: Record<string, unknown>) => Promise<void> }) {
  const refs = [
    ...data.items.map((i) => ({ ref: `item:${i.id}`, label: `${KIND_ICON[i.kind] ?? ''} ${i.title}` })),
    ...data.requirements.map((r) => ({ ref: `req:${r.id}`, label: `📏 ${r.name}` })),
    ...data.decisions.map((d) => ({ ref: `decision:${d.id}`, label: `⚖️ ${d.title}` })),
    ...data.tasks.map((t) => ({ ref: `task:${t.id}`, label: `☐ ${t.title}` })),
  ];
  const label = (r: string) => refs.find((x) => x.ref === r)?.label ?? 'removed';
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [what, setWhat] = useState('');
  const [summary, setSummary] = useState('');
  const [impact, setImpact] = useState<string[] | null>(null);
  useEffect(() => {
    setImpact(null);
    if (what) void api.invoke<string[]>('impact', { projectId: data.project.id, ref: what }).then(setImpact).catch(() => setImpact(null));
  }, [api, what, data.project.id]);
  const pick = (v: string, set: (s: string) => void, placeholder: string) => (
    <select className="wb-select grow" value={v} onChange={(e) => set(e.target.value)}>
      <option value="">{placeholder}</option>
      {refs.map((r) => (
        <option key={r.ref} value={r.ref}>
          {r.label.slice(0, 60)}
        </option>
      ))}
    </select>
  );
  return (
    <div>
      <h5 className="pj-h5">Record a change</h5>
      <p className="small muted">Changing a part, datasheet revision or file? Record it here. Evidence that came from it (or from anything linked to it) is marked stale until you re-check it, and you see everything that may need review.</p>
      <div className="row pj-add">
        {pick(what, setWhat, 'What changed? (optional)')}
        <input className="wb-input grow" placeholder="Summary, e.g. MCU changed from STM32F103 to STM32G431" value={summary} onChange={(e) => setSummary(e.target.value)} />
        <button className="wb-btn primary" disabled={!summary.trim()} onClick={() => void call('recordChange', { ref: what || undefined, summary }).then(() => { setSummary(''); setWhat(''); })}>
          Record
        </button>
      </div>
      {impact && (
        <p className="small">
          {impact.length ? <>Would flag for review: {impact.map(label).join(', ')}</> : 'Nothing is linked to it yet.'}
        </p>
      )}
      <h5 className="pj-h5">Traceability links</h5>
      <p className="small muted">Link requirements to decisions, components to datasheets, code to hardware, tests to requirements.</p>
      <div className="row pj-add">
        {pick(from, setFrom, 'From…')}
        <span>↔</span>
        {pick(to, setTo, 'To…')}
        <button className="wb-btn" disabled={!from || !to || from === to} onClick={() => void call('link', { from, to }).then(() => { setFrom(''); setTo(''); })}>
          Link
        </button>
      </div>
      {data.links.map((l) => (
        <div key={l.id} className="list-row small">
          <span className="grow">
            {label(l.from)} ↔ {label(l.to)}
          </span>
          <button className="wb-icon small" title="Remove link" onClick={() => void call('unlink', { id: l.id })}>
            ✕
          </button>
        </div>
      ))}
      <h5 className="pj-h5">Change log</h5>
      {!data.changes.length && <p className="small muted">No changes recorded.</p>}
      {data.changes.map((c) => (
        <div key={c.id} className="list-row small">
          <span className="muted">{new Date(c.at).toLocaleString()}</span>
          <span className="grow">
            {c.summary}
            {!!c.impacted.length && <span className="muted"> · flagged {c.impacted.map(label).join(', ')}</span>}
          </span>
        </div>
      ))}
      <h5 className="pj-h5">Archive</h5>
      <button className="wb-btn small" onClick={() => void api.invoke('export', { id: data.project.id }).then((j) => api.download(`${data.project.name.replace(/[^\w-]+/g, '_')}.aether-project.json`, JSON.stringify(j, null, 2), 'application/json'))}>
        Export project (JSON)
      </button>
    </div>
  );
}
