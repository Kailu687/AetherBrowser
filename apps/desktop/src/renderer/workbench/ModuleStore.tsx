import { useMemo, useState } from 'react';
import type { ModuleManifest, WorkbenchAppApi } from '@aether/plugin-api';
import { refreshAddons, useModules, workbench, type ModuleStatusRow, type ModulesState } from './store';

const CATEGORY: Record<string, string> = {
  research: 'Research & Writing',
  electronics: 'Electronics & ECE',
  developer: 'Developer',
  software: 'Developer',
  aerospace: 'Aerospace & Space',
  rf: 'Aerospace & Space',
  mechanical: 'Mechanical',
  civil: 'Civil & Structural',
  bio: 'Biotech',
  data: 'Data Science & AI',
  math: 'Math, Physics & Computing',
  other: 'Other',
};
const RISK_LABEL = { low: 'Low', medium: 'Medium', high: 'High' } as const;
const STUDIO_LABEL: Record<string, string> = { 'process.run': 'Code: run programs on this PC', 'process.servers': 'Code: terminal and local servers' };

type ErrorResult = { error?: { message: string; code: string } };

/**
 * Module Store: install specialist toolkits like game expansions. Every module
 * ships inside the signed app, so installing is instant and offline; what you
 * approve here is what the core lets it do.
 */
export function ModuleStore({ api }: { api: WorkbenchAppApi }) {
  const s = useModules();
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'installed'>('all');
  const [msg, setMsg] = useState<string | null>(null);
  if (!s) return <div className="wb-loading">Loading modules…</div>;
  const row = (id: string) => s.status.find((r) => r.id === id)!;
  const list = s.catalog.filter((m) => filter === 'all' || row(m.id)?.installed);
  const selected = open ? s.catalog.find((m) => m.id === open) ?? null : null;
  const run = async (method: string, payload: unknown) => {
    setMsg(null);
    const r = (await api.invoke(method, payload)) as ErrorResult;
    if (r?.error) setMsg(r.error.message);
    await refreshAddons();
    return !r?.error;
  };

  return (
    <div className="store">
      <header className="store-hero">
        <div>
          <h1>Module Store</h1>
          <p className="muted">
            Specialist toolkits for your field. Each module is built into this version of AETHER, so installing is instant and works offline. It can only do what you approve here, and you can turn it off or remove it any time. Your data from it is kept.
          </p>
        </div>
        <div className="store-count">
          <b>{s.installed.length}</b>/<span>{s.catalog.length}</span>
          <small>installed</small>
        </div>
      </header>
      {s.safeMode && <p className="wb-note warn">Safe mode is on: every module is off until you restart AETHER normally.</p>}
      {msg && (
        <p className="wb-note warn" role="alert">
          {msg}
        </p>
      )}
      <div className="store-tools">
        <div className="wb-seg" role="group" aria-label="Filter">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
            All
          </button>
          <button className={filter === 'installed' ? 'on' : ''} onClick={() => setFilter('installed')}>
            Installed
          </button>
        </div>
        <span className="grow" />
        {!s.safeMode && (
          <button className="wb-btn small" title="Restart with every module off, to recover from a faulty module" onClick={() => confirm('Restart AETHER with every module turned off?') && void api.invoke('restartSafeMode')}>
            Restart in safe mode
          </button>
        )}
      </div>
      {!s.catalog.length && (
        <div className="wb-card">
          <b>No modules in this build yet.</b>
          <p className="muted small">Modules arrive with app updates. Writer, Code, Projects and Engineering are built in and always available.</p>
        </div>
      )}
      <div className="store-grid">
        {list.map((m) => (
          <ModuleCard key={m.id} m={m} r={row(m.id)} onOpen={() => setOpen(m.id)} />
        ))}
      </div>
      <StudioConsent s={s} run={run} />
      {selected && <ModuleDetail m={selected} r={row(selected.id)} s={s} run={run} onClose={() => setOpen(null)} />}
    </div>
  );
}

function state(r: ModuleStatusRow): { label: string; cls: string } {
  if (!r.installed) return { label: '', cls: '' };
  if (r.needsReview) return { label: 'Review', cls: 'warn' };
  if (!r.installed.enabled) return { label: 'Off', cls: 'off' };
  if (!r.active) return { label: 'Safe mode', cls: 'off' };
  return { label: 'Installed', cls: '' };
}

function ModuleCard({ m, r, onOpen }: { m: ModuleManifest; r: ModuleStatusRow; onOpen: () => void }) {
  const st = state(r);
  return (
    <article className="pack" style={{ ['--pack' as string]: m.color }}>
      <button className="pack-art" onClick={onOpen} aria-label={`About ${m.name}`}>
        <span className="pack-icon">{m.icon}</span>
        <span className="pack-ver">v{m.version}</span>
        {st.label && <span className={`pack-owned ${st.cls}`}>{st.label}</span>}
      </button>
      <div className="pack-body">
        <small className="muted">{CATEGORY[m.category] ?? m.category}</small>
        <h3>{m.name}</h3>
        <p className="muted small">{m.tagline}</p>
        <ul className="pack-feats">
          {m.features.slice(0, 4).map((f) => (
            <li key={f.title}>
              {f.title}
              {f.online && <span className="pill online">online</span>}
            </li>
          ))}
        </ul>
        <div className="pack-meta small muted">
          {m.network === 'none' ? 'Works fully offline' : 'Some features go online'} · {m.permissions.length || 'no'} permission{m.permissions.length === 1 ? '' : 's'}
          {!r.compatible && <div className="danger">Needs AETHER {m.engines.aether}</div>}
          {!r.osSupported && <div className="danger">Not available on this operating system</div>}
        </div>
        <button className={`wb-btn ${r.installed ? '' : 'primary'}`} onClick={onOpen}>
          {r.installed ? (r.needsReview ? 'Review permissions' : 'Manage') : 'Details & install'}
        </button>
      </div>
    </article>
  );
}

function ModuleDetail({ m, r, s, run, onClose }: { m: ModuleManifest; r: ModuleStatusRow; s: ModulesState; run: (method: string, p: unknown) => Promise<boolean>; onClose: () => void }) {
  const needsApproval = m.permissions.filter((p) => p !== 'storage');
  const [approved, setApproved] = useState<Set<string>>(() => new Set(r.installed && !r.needsReview ? needsApproval : []));
  const allApproved = needsApproval.every((p) => approved.has(p));
  const depName = (id: string) => s.catalog.find((c) => c.id === id)?.name ?? id;
  const blocked = !r.compatible ? `Needs AETHER ${m.engines.aether}; this is ${s.appVersion}.` : !r.osSupported ? 'Not available on this operating system.' : r.missingDeps.length ? `Install ${r.missingDeps.map(depName).join(', ')} first.` : null;
  const toggle = (p: string) => setApproved((cur) => {
    const n = new Set(cur);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });
  const install = async () => {
    if (await run('install', { id: m.id, approved: [...approved] })) {
      if (!r.installed) onClose();
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${m.name}? Its data stays on this PC and comes back if you reinstall.`)) return;
    for (const a of m.apps) workbench.closeApp(a.id);
    if (await run('uninstall', { id: m.id })) onClose();
  };
  const setEnabled = async (enabled: boolean) => {
    if (!enabled) for (const a of m.apps) workbench.closeApp(a.id);
    await run('setEnabled', { id: m.id, enabled });
  };
  const risks = useMemo(() => needsApproval.map((p) => ({ p, ...(s.permissions[p] ?? { label: p, risk: 'high' as const, detail: '' }) })), [needsApproval, s.permissions]);

  return (
    <div className="wb-modal-back" onClick={onClose}>
      <div className="wb-modal wide" role="dialog" aria-label={m.name} onClick={(e) => e.stopPropagation()} style={{ ['--pack' as string]: m.color }}>
        <div className="row gap">
          <span className="pack-icon big">{m.icon}</span>
          <div className="grow">
            <h2>{m.name}</h2>
            <small className="muted">
              {CATEGORY[m.category] ?? m.category} · v{m.version} · {m.license}
              {m.sizeMb ? ` · about ${m.sizeMb} MB` : ''}
            </small>
          </div>
          <button className="wb-icon" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p>{m.description}</p>

        <h3>What it does</h3>
        <ul className="pack-feats full">
          {m.features.map((f) => (
            <li key={f.title}>
              <b>{f.title}</b>
              {f.online && <span className="pill online">online</span>} — <span className="muted">{f.detail}</span>
            </li>
          ))}
        </ul>

        <h3>What it can't do</h3>
        <ul className="pack-feats full">
          {m.limits.map((l) => (
            <li key={l} className="muted">
              {l}
            </li>
          ))}
        </ul>

        {!!m.externalApps?.length && (
          <>
            <h3>Programs it can use</h3>
            <p className="small muted">These are never bundled. Install them yourself if you want these features; the module tells you when one is missing.</p>
            <ul className="pack-feats full">
              {m.externalApps.map((x) => (
                <li key={x.program}>
                  <b>{x.name}</b> <span className="mono small">({x.program})</span> {x.optional ? <span className="muted small">optional</span> : <span className="danger small">required</span>} — <span className="muted">{x.purpose}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {!!m.dependencies && !!Object.keys(m.dependencies).length && (
          <p className="small">
            Builds on:{' '}
            {Object.entries(m.dependencies)
              .map(([id, range]) => `${depName(id)} ${range}`)
              .join(', ')}
          </p>
        )}

        {!!m.advisories?.length && (
          <>
            <h3>Security advisories</h3>
            {m.advisories.map((a) => (
              <p key={a.id} className={`wb-note ${a.severity === 'high' ? 'warn' : ''}`}>
                <b>{a.id}</b> ({a.severity}, affects {a.affected}): {a.summary}
              </p>
            ))}
          </>
        )}

        <h3>Permissions</h3>
        {r.needsReview && <p className="wb-note warn">This module changed since you approved it. Only the permissions you approved before stay on until you review.</p>}
        {!risks.length && <p className="small muted">Only its own storage. It can't reach the internet, your files or other programs.</p>}
        <div className="perm-list">
          {risks.map((x) => (
            <label key={x.p} className={`perm risk-${x.risk}`}>
              <input type="checkbox" checked={approved.has(x.p)} onChange={() => toggle(x.p)} />
              <span className="grow">
                <b>{x.label}</b>
                <small className="muted">{x.detail}</small>
              </span>
              <span className={`risk ${x.risk}`}>{RISK_LABEL[x.risk]} risk</span>
            </label>
          ))}
        </div>
        <p className="small muted">Never available to any module: your cookies, saved passwords, browsing history, Google sign-in or other modules' data.</p>

        {!!m.changelog?.length && (
          <details>
            <summary>Changelog</summary>
            {m.changelog.map((c) => (
              <div key={c.version} className="small">
                <b>
                  {c.version}
                </b>{' '}
                <span className="muted">{c.date}</span>
                <ul>
                  {c.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </div>
            ))}
          </details>
        )}
        {m.integrity && <p className="small muted mono">Integrity: {m.integrity.slice(0, 24)}…</p>}

        <div className="row gap wrap" style={{ marginTop: 8 }}>
          {blocked && <span className="danger small grow">{blocked}</span>}
          {!blocked && <span className="grow" />}
          {r.installed && (
            <>
              <button className="wb-btn danger" onClick={() => void remove()}>
                Remove
              </button>
              <button className="wb-btn" disabled={s.safeMode} onClick={() => void setEnabled(!r.installed!.enabled)}>
                {r.installed.enabled ? 'Turn off' : 'Turn on'}
              </button>
            </>
          )}
          {(!r.installed || r.needsReview) && (
            <button className="wb-btn primary" disabled={!!blocked || !allApproved} title={allApproved ? '' : 'Tick every permission to approve it'} onClick={() => void install()}>
              {r.installed ? 'Approve and update' : needsApproval.length ? 'Approve and install' : 'Install'}
            </button>
          )}
          {r.installed && r.active && m.apps[0] && (
            <button className="wb-btn primary" onClick={() => workbench.open(m.apps[0].id)}>
              Open {m.apps[0].title}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StudioConsent({ s, run }: { s: ModulesState; run: (method: string, p: unknown) => Promise<boolean> }) {
  if (!s.studioConsent.length) return null;
  return (
    <section className="wb-card" style={{ marginTop: 24 }}>
      <h3 style={{ marginTop: 0 }}>Built-in app permissions</h3>
      <p className="small muted">You allowed these in the built-in apps. Revoke one and the app asks again next time.</p>
      {s.studioConsent.map((p) => (
        <div key={p} className="row gap">
          <span className="grow">{STUDIO_LABEL[p] ?? s.permissions[p]?.label ?? p}</span>
          <button className="wb-btn small" onClick={() => void run('consent', { permission: p, allow: false })}>
            Revoke
          </button>
        </div>
      ))}
    </section>
  );
}
