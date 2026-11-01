import { useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import type { Reference } from "@aether/citations";
import type { LabProject } from "../../model.js";
import type { CitationGraph } from "../../graph.js";
import { Empty, ExtLink, FlashLine, OnlineBadge, library, useAction, useLoad } from "../shared.js";

/** Citation links between sources, related-paper suggestions with reasons, and a timeline of the review's sources. */
export function GraphView({ api, project, onChanged }: { api: WorkbenchAppApi; project: LabProject; onChanged: () => void }) {
  const [cached] = useLoad(() => api.invoke<CitationGraph | null>("projects.graph", { id: project.id, cached: true }), [project.id]);
  const [timeline] = useLoad(() => api.invoke<Array<{ year: number; ids: string[] }>>("projects.timeline", { id: project.id }), [project]);
  const [fresh, setFresh] = useState<CitationGraph>();
  const { busy, flash, run } = useAction();
  const g = fresh ?? cached ?? undefined;
  const title = (id: string) => g?.nodes.find((n) => n.id === id)?.title ?? id;
  const mine = g?.nodes.filter((n) => n.inProject) ?? [];
  const max = Math.max(1, ...(timeline ?? []).map((t) => t.ids.length));

  return (
    <div>
      <div className="rsx-section">Sources in this review by year (offline)</div>
      {timeline?.length ? (
        <>
          <div className="rsx-bars">{timeline.map((t) => <span key={t.year} title={`${t.year}: ${t.ids.join(", ")}`} style={{ height: `${(t.ids.length / max) * 100}%` }} />)}</div>
          <div className="rsx-row rsx-muted"><span>{timeline[0]!.year}</span><span className="rsx-grow" /><span>{timeline.at(-1)!.year}</span></div>
        </>
      ) : <p className="rsx-muted">No dated sources yet.</p>}
      <div className="rsx-row">
        <div className="rsx-section rsx-grow">Citation graph <OnlineBadge /></div>
        <button className="wb-btn small primary" disabled={busy} onClick={() => run(async () => setFresh(await api.invoke<CitationGraph>("projects.graph", { id: project.id })), (x) => void x)}>{g ? "Rebuild" : "Build from OpenAlex"}</button>
      </div>
      <p className="rsx-muted">Looks up each included source with a DOI in OpenAlex, links sources that cite each other, and suggests works cited by or citing at least two of your sources, with the reason. One request per source; results are kept for offline viewing.</p>
      <FlashLine flash={flash} />
      {!g ? <Empty>Not built yet.</Empty> : (
        <>
          <p className="rsx-muted">Built {new Date(g.builtAt).toLocaleString()} from {g.source}. {g.unresolved.length ? `Not found (no DOI or not indexed): ${g.unresolved.join(", ")}.` : ""}</p>
          <table className="wb-table">
            <thead><tr><th>Your source</th><th>Cites (in this review)</th><th>Cited by (in this review)</th></tr></thead>
            <tbody>{mine.map((n) => (
              <tr key={n.id}>
                <td>{n.title}<div className="rsx-muted">{n.refId} · cited {n.citedBy?.toLocaleString() ?? "?"} times overall</div></td>
                <td>{g.edges.filter((e) => e.from === n.id && mine.some((m) => m.id === e.to)).map((e) => title(e.to)).join("; ") || "—"}</td>
                <td>{g.edges.filter((e) => e.to === n.id && mine.some((m) => m.id === e.from)).map((e) => title(e.from)).join("; ") || "—"}</td>
              </tr>
            ))}</tbody>
          </table>
          <div className="rsx-section">Related papers</div>
          {!g.suggestions.length ? <p className="rsx-muted">No work is linked to two or more of your sources.</p> : (
            <div className="rsx-list">{g.suggestions.map((s) => (
              <div key={s.hit.key} className="rsx-item">
                <h4>{s.hit.reference.title}</h4>
                <ul className="rsx-muted">{s.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
                <div className="rsx-row">
                  <button className="wb-btn small" disabled={busy} onClick={() => run(async () => { const it = await library.add(api, { ...s.hit.reference, id: "" } as Reference); await api.invoke("projects.addSources", { id: project.id, refs: [it.ref] }); onChanged(); return it; }, (it) => `Added ${it.id} to this review.`)}>Add to review</button>
                  {s.hit.found.map((f) => f.url && <ExtLink key={f.service} api={api} href={f.url}>OpenAlex ↗</ExtLink>)}
                  {s.hit.reference.DOI && <ExtLink api={api} href={`https://doi.org/${s.hit.reference.DOI}`}>DOI ↗</ExtLink>}
                </div>
              </div>
            ))}</div>
          )}
        </>
      )}
    </div>
  );
}
