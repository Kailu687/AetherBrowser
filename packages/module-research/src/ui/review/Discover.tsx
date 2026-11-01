import { useMemo, useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import type { Reference } from "@aether/citations";
import { SERVICE_INFO, type DiscoveryHit, type DiscoveryService } from "../../model.js";
import type { DiscoveryRun } from "../../discovery.js";
import type { TopicTimeline } from "../../graph.js";
import { Empty, ExtLink, FlashLine, OnlineBadge, library, refLabel, useAction, useLoad } from "../shared.js";

export function Discover({ api, projects, onProjectsChanged }: { api: WorkbenchAppApi; projects: Array<{ id: string; title: string }>; onProjectsChanged: () => void }) {
  const [text, setText] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [oa, setOa] = useState(false);
  const [run, setRun] = useState<DiscoveryRun>();
  const [timeline, setTimeline] = useState<TopicTimeline>();
  const [target, setTarget] = useState<string>("");
  const [history] = useLoad(() => api.invoke<DiscoveryRun[]>("discover.history"), []);
  const [lib, reloadLib] = useLoad(() => library.list(api), []);
  const { busy, flash, run: act } = useAction();
  const libByDoi = useMemo(() => new Map((lib ?? []).filter((i) => i.ref.DOI).map((i) => [i.ref.DOI!.toLowerCase(), i.id])), [lib]);

  const search = () => act(async () => {
    setTimeline(undefined);
    setRun(await api.invoke<DiscoveryRun>("discover.search", { text, fromYear: from ? Number(from) : undefined, toYear: to ? Number(to) : undefined, openAccessOnly: oa }));
  });
  const add = (hit: DiscoveryHit, projectId?: string) => act(async () => {
    const existing = hit.reference.DOI ? libByDoi.get(hit.reference.DOI.toLowerCase()) : undefined;
    const item = existing ? lib!.find((i) => i.id === existing)! : await library.add(api, { ...hit.reference, id: "" } as Reference);
    if (projectId) await api.invoke("projects.addSources", { id: projectId, refs: [item.ref] });
    reloadLib();
    onProjectsChanged();
    return item;
  }, (item) => (projectId ? `Added ${item.id} to the review.` : existing(hit) ? `Already in your library as ${item.id}.` : `Added ${item.id} to your library.`));
  const existing = (h: DiscoveryHit) => (h.reference.DOI ? libByDoi.get(h.reference.DOI.toLowerCase()) : undefined);
  const scholar = () => act(async () => api.openUrl(await api.invoke<string>("discover.scholarLink", { text })));
  const showTimeline = () => act(async () => setTimeline(await api.invoke<TopicTimeline>("discover.timeline", { text })));
  const max = Math.max(1, ...(timeline?.years.map((y) => y.count) ?? [1]));

  return (
    <div>
      <h2>Discover papers <OnlineBadge /></h2>
      <p className="rsx-muted">Searches {Object.values(SERVICE_INFO).map((s) => s.label).join(", ")} (whichever you enabled in Settings) and merges duplicates. Only your search terms are sent. Results are real records from those services; nothing is generated.</p>
      <form className="rsx-row" onSubmit={(e) => (e.preventDefault(), text.trim().length > 1 && void search())}>
        <input className="wb-input rsx-grow" placeholder="e.g. chopper amplifier ECG low power" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search terms" />
        <input className="wb-input" style={{ width: 80 }} placeholder="From" inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value.replace(/\D/g, "").slice(0, 4))} aria-label="From year" />
        <input className="wb-input" style={{ width: 80 }} placeholder="To" inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, "").slice(0, 4))} aria-label="To year" />
        <label className="rsx-muted"><input type="checkbox" checked={oa} onChange={(e) => setOa(e.target.checked)} /> Open access only</label>
        <button className="wb-btn primary" disabled={busy || text.trim().length < 2}>Search</button>
        <button type="button" className="wb-btn" disabled={busy || text.trim().length < 2} onClick={showTimeline}>Timeline</button>
        <button type="button" className="wb-btn" disabled={text.trim().length < 2} onClick={scholar} title="Opens Google Scholar in a normal tab">Google Scholar ↗</button>
      </form>
      <div className="rsx-row">
        <span className="rsx-muted">Add results to:</span>
        <select className="wb-select" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target review">
          <option value="">Library only</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </select>
      </div>
      <FlashLine flash={flash} />
      {timeline && (
        <div className="wb-card">
          <b>Works per year for “{timeline.query}”</b>
          <div className="rsx-bars" aria-label="Publications per year">{timeline.years.map((y) => <span key={y.year} title={`${y.year}: ${y.count.toLocaleString()}`} style={{ height: `${(y.count / max) * 100}%` }} />)}</div>
          <div className="rsx-row rsx-muted"><span>{timeline.years[0]?.year}</span><span className="rsx-grow" /><span>{timeline.years.at(-1)?.year}</span></div>
          <p className="rsx-muted">{timeline.note} Source: {timeline.source}.</p>
        </div>
      )}
      {run && (
        <p className="rsx-muted">
          {run.hits.length} merged results.{" "}
          {run.services.map((s) => `${SERVICE_INFO[s.service].label}: ${s.error ? `failed (${s.error})` : `${s.count}${s.total ? ` of ${s.total.toLocaleString()}` : ""}`}`).join(" · ")}
        </p>
      )}
      {run ? (
        !run.hits.length ? <Empty>No results. Try fewer or different words.</Empty> : (
          <div className="rsx-list">{run.hits.map((h) => <HitCard key={h.key} api={api} hit={h} inLibrary={existing(h)} busy={busy} onAdd={() => add(h, target || undefined)} onQueue={() => act(async () => { const item = await add(h); if (item) await api.invoke("reading.set", { refId: item.id, title: item.ref.title }); }, () => "Queued to read.")} />)}</div>
        )
      ) : history?.length ? (
        <>
          <div className="rsx-section">Recent searches (available offline)</div>
          {history.map((r, i) => <button key={i} className="wb-btn small" style={{ margin: 2 }} onClick={() => (setRun(r), setText(r.query.text))}>{r.query.text} · {r.hits.length}</button>)}
        </>
      ) : null}
    </div>
  );
}

function HitCard({ api, hit, inLibrary, busy, onAdd, onQueue }: { api: WorkbenchAppApi; hit: DiscoveryHit; inLibrary?: string; busy: boolean; onAdd: () => void; onQueue: () => void }) {
  const [more, setMore] = useState(false);
  const r = hit.reference;
  return (
    <div className="rsx-item">
      <h4>{r.title}</h4>
      <p className="rsx-muted">
        {refLabel(r)}{r["container-title"] ? ` · ${r["container-title"]}` : ""}{r.DOI ? ` · doi:${r.DOI}` : ""}{hit.citedBy !== undefined ? ` · cited by ${hit.citedBy.toLocaleString()}` : ""}
      </p>
      <div>
        {hit.found.map((f) => <span key={f.service} className="rsx-tag">{SERVICE_INFO[f.service].label}</span>)}
        {hit.isRetracted && <span className="rsx-tag bad">Marked retracted (OpenAlex)</span>}
        {/arxiv/i.test(r.archive ?? "") && !r.DOI && <span className="rsx-tag warn">Preprint</span>}
        {inLibrary && <span className="rsx-tag ok">In library: {inLibrary}</span>}
      </div>
      {r.abstract && <p>{more ? r.abstract : `${r.abstract.slice(0, 280)}${r.abstract.length > 280 ? "…" : ""}`} {r.abstract.length > 280 && <button className="wb-link" onClick={() => setMore(!more)}>{more ? "less" : "more"}</button>}</p>}
      <div className="rsx-row">
        <button className="wb-btn small primary" disabled={busy} onClick={onAdd}>{inLibrary ? "Use" : "Add"}</button>
        <button className="wb-btn small" disabled={busy} onClick={onQueue}>Queue to read</button>
        {hit.openAccessUrl && <ExtLink api={api} href={hit.openAccessUrl}>Open-access copy ↗</ExtLink>}
        {hit.found.map((f) => f.url && <ExtLink key={f.service} api={api} href={f.url}>{SERVICE_INFO[f.service].label} ↗</ExtLink>)}
      </div>
    </div>
  );
}
