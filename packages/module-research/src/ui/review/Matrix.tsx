import { useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import { EXTRACTION_FIELDS, FIELD_LABELS, type Criterion, type LabProject } from "../../model.js";
import type { Matrix } from "../../analysis.js";
import { Empty, FlashLine, useAction, useLoad } from "../shared.js";

/** Comparison matrix: sources × criteria. Empty cells stay empty; nothing is inferred. */
export function MatrixView({ api, project, onChanged }: { api: WorkbenchAppApi; project: LabProject; onChanged: () => void }) {
  const [m, reload] = useLoad(() => api.invoke<Matrix>("matrix.get", { projectId: project.id }), [project]);
  const [bench] = useLoad(() => api.invoke<Array<{ dataset: string; metrics: string[]; sources: string[] }>>("projects.benchmarks", { id: project.id }), [project]);
  const [edit, setEdit] = useState<{ sourceId: string; criterionId: string; text: string }>();
  const [term, setTerm] = useState("");
  const [termHits, setTermHits] = useState<string[]>();
  const { busy, flash, run } = useAction();

  const saveCell = () => edit && run(async () => (await api.invoke("projects.setCell", { id: project.id, ...edit }), setEdit(undefined), onChanged(), reload()));
  const setCriteria = (criteria: Criterion[]) => run(async () => (await api.invoke("projects.update", { id: project.id, criteria }), onChanged()));
  const addColumn = () => {
    const label = prompt("Column name (e.g. “Supply voltage”, “Sample size”)");
    if (!label?.trim()) return;
    const fieldName = prompt(`Fill it from an extraction field? Type one of: ${EXTRACTION_FIELDS.join(", ")}. Leave empty to type values yourself.`)?.trim();
    void setCriteria([...project.criteria, { id: `c${Date.now().toString(36)}`, label, field: EXTRACTION_FIELDS.includes(fieldName as never) ? (fieldName as Criterion["field"]) : undefined }]);
  };
  const exportAs = (format: "csv" | "markdown") => run(async () => api.download(`matrix.${format === "csv" ? "csv" : "md"}`, await api.invoke<string>("matrix.export", { projectId: project.id, format }), format === "csv" ? "text/csv" : "text/markdown"));

  if (!m) return null;
  if (!m.rows.length) return <Empty>Include some sources to compare them.</Empty>;
  return (
    <div>
      <div className="rsx-row">
        <button className="wb-btn small" onClick={addColumn}>+ Column</button>
        <button className="wb-btn small" onClick={() => exportAs("csv")}>Export CSV</button>
        <button className="wb-btn small" onClick={() => exportAs("markdown")}>Export Markdown</button>
        <span className="rsx-grow" />
        <form className="rsx-row" onSubmit={(e) => (e.preventDefault(), void run(async () => setTermHits(await api.invoke<string[]>("projects.searchTerm", { id: project.id, term }))))}>
          <input className="wb-input" placeholder="Find a term across sources" value={term} onChange={(e) => setTerm(e.target.value)} />
          <button className="wb-btn small">Find</button>
        </form>
      </div>
      {termHits && <p className="rsx-muted">“{term}” appears in {termHits.length} source{termHits.length === 1 ? "" : "s"} (titles, abstracts, accepted extractions): {termHits.join(", ") || "none"}.</p>}
      <FlashLine flash={flash} />
      <div className="rsx-matrix">
        <table className="wb-table">
          <thead>
            <tr>
              <th>Source</th>
              {m.criteria.map((c) => (
                <th key={c.id}>
                  {c.label}{c.field && <div className="rsx-muted">from {FIELD_LABELS[c.field]}</div>}
                  <button className="wb-icon small danger" aria-label={`Remove column ${c.label}`} onClick={() => confirm(`Remove column “${c.label}”?`) && setCriteria(project.criteria.filter((x) => x.id !== c.id))}>✕</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.rows.map((r) => (
              <tr key={r.sourceId}>
                <td><b>{r.label}</b><div className="rsx-muted mono">{r.sourceId}</div></td>
                {r.cells.map((c, i) => {
                  const crit = m.criteria[i]!;
                  const editing = edit?.sourceId === r.sourceId && edit.criterionId === crit.id;
                  return (
                    <td key={crit.id} className={c.kind === "empty" ? "empty" : ""} onDoubleClick={() => setEdit({ sourceId: r.sourceId, criterionId: crit.id, text: c.kind === "manual" ? c.text : "" })} title={c.quotes.length ? c.quotes.map((q) => `“${q}”`).join("\n") : "Double-click to type a value"}>
                      {editing ? (
                        <>
                          <textarea className="wb-input" autoFocus value={edit!.text} onChange={(e) => setEdit({ ...edit!, text: e.target.value })} />
                          <button className="wb-btn small primary" disabled={busy} onClick={saveCell}>Save</button> <button className="wb-btn small" onClick={() => setEdit(undefined)}>Cancel</button>
                        </>
                      ) : c.kind === "empty" ? "—" : (
                        <>{c.text}{c.kind === "manual" && <span className="rsx-tag">typed</span>}</>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="rsx-muted">— means not extracted yet. Cells come from accepted extractions (hover to see the quotes) or values you type (double-click a cell).</p>
      {bench && bench.length > 0 && (
        <>
          <div className="rsx-section">Datasets and benchmarks</div>
          <table className="wb-table">
            <thead><tr><th>Dataset</th><th>Metrics reported</th><th>Sources</th></tr></thead>
            <tbody>{bench.map((b) => <tr key={b.dataset}><td>{b.dataset}</td><td>{b.metrics.join(", ") || "—"}</td><td>{b.sources.join(", ")}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </div>
  );
}
