import { useMemo, useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import type { LabProject, ScreeningDecision } from "../../model.js";
import { Empty, FlashLine, library, refLabel, useAction, useLoad } from "../shared.js";

/** Scope, inclusion/exclusion criteria, adding sources from the library, and screening. */
export function Sources({ api, project, onChanged }: { api: WorkbenchAppApi; project: LabProject; onChanged: () => void }) {
  const [lib] = useLoad(() => library.list(api), []);
  const [filter, setFilter] = useState<"all" | "unscreened" | ScreeningDecision["status"]>("all");
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const { busy, flash, run } = useAction();
  const scope = project.scope ?? { inclusion: [], exclusion: [] };
  const [draft, setDraft] = useState({ statement: scope.statement ?? project.description ?? "", inclusion: scope.inclusion.join("\n"), exclusion: scope.exclusion.join("\n"), fromYear: scope.fromYear ? String(scope.fromYear) : "", toYear: scope.toYear ? String(scope.toYear) : "" });
  const notIn = useMemo(() => (lib ?? []).filter((i) => !project.sourceIds.includes(i.id) && (!q || `${i.ref.title} ${i.id}`.toLowerCase().includes(q.toLowerCase()))), [lib, project, q]);

  const saveScope = () => run(async () => {
    await api.invoke("projects.setScope", { id: project.id, statement: draft.statement, inclusion: draft.inclusion.split("\n"), exclusion: draft.exclusion.split("\n"), fromYear: draft.fromYear ? Number(draft.fromYear) : undefined, toYear: draft.toYear ? Number(draft.toYear) : undefined });
    onChanged();
  }, () => "Scope saved.");
  const screen = (sourceId: string, status: ScreeningDecision["status"] | null, criteria: string[] = [], reason?: string) => run(async () => (await api.invoke("projects.screen", { id: project.id, sourceId, status, criteria, reason }), onChanged()));
  const exclude = (sourceId: string) => {
    if (!scope.exclusion.length) {
      const reason = prompt("Reason for excluding (optional)") ?? undefined;
      return screen(sourceId, "exclude", [], reason);
    }
    const pick = prompt(`Which exclusion criterion applies?\n${scope.exclusion.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n\nType a number, or a free-text reason.`);
    if (pick === null) return;
    const n = Number(pick);
    return Number.isInteger(n) && scope.exclusion[n - 1] ? screen(sourceId, "exclude", [scope.exclusion[n - 1]!]) : screen(sourceId, "exclude", [], pick);
  };
  const shown = project.sourceIds.filter((id) => {
    const s = project.screening[id]?.status;
    return filter === "all" || (filter === "unscreened" ? !s : s === filter);
  });

  return (
    <div>
      <details className="wb-card" open={!project.scope}>
        <summary><b>Scope and criteria</b></summary>
        <label className="rsx-muted">Scope<textarea className="wb-input" style={{ width: "100%" }} rows={2} value={draft.statement} onChange={(e) => setDraft({ ...draft, statement: e.target.value })} /></label>
        <div className="wb-form">
          <label>Inclusion criteria (one per line)<textarea className="wb-input" rows={4} value={draft.inclusion} onChange={(e) => setDraft({ ...draft, inclusion: e.target.value })} /></label>
          <label>Exclusion criteria (one per line)<textarea className="wb-input" rows={4} value={draft.exclusion} onChange={(e) => setDraft({ ...draft, exclusion: e.target.value })} /></label>
          <label>From year<input className="wb-input" value={draft.fromYear} onChange={(e) => setDraft({ ...draft, fromYear: e.target.value.replace(/\D/g, "").slice(0, 4) })} /></label>
          <label>To year<input className="wb-input" value={draft.toYear} onChange={(e) => setDraft({ ...draft, toYear: e.target.value.replace(/\D/g, "").slice(0, 4) })} /></label>
        </div>
        <div className="rsx-row end"><button className="wb-btn primary small" disabled={busy} onClick={saveScope}>Save scope</button></div>
      </details>
      <FlashLine flash={flash} />
      <div className="rsx-row">
        <div className="wb-seg">{(["all", "unscreened", "include", "maybe", "exclude"] as const).map((f) => <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>)}</div>
        <span className="rsx-grow" />
        <button className="wb-btn small" onClick={() => setAdding(!adding)}>{adding ? "Done adding" : "Add from library"}</button>
      </div>
      {adding && (
        <div className="wb-card">
          <input className="wb-input" style={{ width: "100%" }} placeholder="Filter your library" value={q} onChange={(e) => setQ(e.target.value)} />
          {!notIn.length ? <p className="rsx-muted">Everything in your library is already in this review. Use Discover to find more.</p> : (
            <table className="wb-table"><tbody>{notIn.slice(0, 100).map((i) => (
              <tr key={i.id}><td>{i.ref.title ?? i.id}<div className="rsx-muted">{refLabel(i.ref, i.id)}</div></td><td><button className="wb-btn small" disabled={busy} onClick={() => run(async () => (await api.invoke("projects.addSources", { id: project.id, refs: [i.ref] }), onChanged()))}>Add</button></td></tr>
            ))}</tbody></table>
          )}
        </div>
      )}
      {!shown.length ? <Empty>No sources here yet. Add them from your library or from Discover.</Empty> : (
        <div className="rsx-list">
          {shown.map((id) => {
            const r = project.sources[id];
            const d = project.screening[id];
            return (
              <div key={id} className="rsx-item">
                <h4>{r?.title ?? id}</h4>
                <p className="rsx-muted">{refLabel(r, id)} · <span className="mono">{id}</span>{r?.DOI ? ` · doi:${r.DOI}` : ""}</p>
                {r?.abstract && <p>{r.abstract.slice(0, 400)}{r.abstract.length > 400 ? "…" : ""}</p>}
                {d && <p><span className={`rsx-tag ${d.status === "include" ? "ok" : d.status === "exclude" ? "bad" : "warn"}`}>{d.status}</span><span className="rsx-muted">{[...(d.criteria ?? []), d.reason].filter(Boolean).join("; ")}</span></p>}
                <div className="rsx-row">
                  <button className="wb-btn small" disabled={busy} onClick={() => screen(id, "include", scope.inclusion.length === 1 ? scope.inclusion : [])}>Include</button>
                  <button className="wb-btn small" disabled={busy} onClick={() => screen(id, "maybe")}>Maybe</button>
                  <button className="wb-btn small" disabled={busy} onClick={() => exclude(id)}>Exclude…</button>
                  {d && <button className="wb-btn small" disabled={busy} onClick={() => screen(id, null)}>Clear</button>}
                  <span className="rsx-grow" />
                  <button className="wb-btn small danger" disabled={busy} onClick={() => confirm("Remove this source and its extractions and evidence from the review?") && run(async () => (await api.invoke("projects.removeSource", { id: project.id, sourceId: id }), onChanged()))}>Remove</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
