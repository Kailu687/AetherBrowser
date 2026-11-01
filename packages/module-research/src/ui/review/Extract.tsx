import { useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import { EXTRACTION_FIELDS, FIELD_LABELS, type ExtractionField, type ExtractionItem, type LabProject } from "../../model.js";
import { Empty, FlashLine, refLabel, useAction, useLoad } from "../shared.js";
import { includedIds } from "./util.js";

const ORIGIN: Record<ExtractionItem["origin"], string> = { manual: "You", heuristic: "Cue-phrase suggestion", ai: "AI suggestion" };

/** Extract methods, datasets, metrics, findings, limitations and future work, with verbatim quotes. */
export function Extract({ api, project }: { api: WorkbenchAppApi; project: LabProject }) {
  const ids = includedIds(project);
  const [picked, setSourceId] = useState(ids[0] ?? "");
  // Fall back to the first included source if the pick is gone (or the list was empty at first render).
  const sourceId = ids.includes(picked) ? picked : (ids[0] ?? "");
  const [items, reload] = useLoad(() => (sourceId ? api.invoke<ExtractionItem[]>("extract.list", { projectId: project.id, sourceId }) : Promise.resolve([])), [sourceId]);
  const [useAi, setUseAi] = useState(false);
  const [paste, setPaste] = useState<string>();
  const [showRejected, setShowRejected] = useState(false);
  const { busy, flash, run } = useAction();
  const ref = project.sources[sourceId];

  const suggest = (from: "abstract" | "supplied-text" | "page", text?: string) => run(async () => {
    const r = await api.invoke<{ created: ExtractionItem[]; ai: { used: boolean; added: number; rejected: Array<{ reason: string; text?: string }>; message?: string } }>("extract.suggest", { projectId: project.id, sourceId, from, text, useAi });
    reload();
    setPaste(undefined);
    return r;
  }, (r) => [`${r.created.length} new suggestion${r.created.length === 1 ? "" : "s"} to review.`, r.ai.message, r.ai.used && r.ai.rejected.length ? `${r.ai.rejected.length} AI suggestion${r.ai.rejected.length === 1 ? " was" : "s were"} dropped because the quote was not in the text.` : ""].filter(Boolean).join(" "));
  const update = (id: string, patch: Record<string, unknown>) => run(async () => (await api.invoke("extract.update", { id, ...patch }), reload()));
  const addManual = (field: ExtractionField) => {
    const text = prompt(`${FIELD_LABELS[field]} (your words)`);
    if (!text?.trim()) return;
    const quote = prompt("Supporting quote from the paper (optional)") ?? undefined;
    const page = prompt("Page (optional)") ?? "";
    void run(async () => (await api.invoke("extract.create", { projectId: project.id, sourceId, field, text, quote: quote || undefined, locator: /^\d+$/.test(page) ? { page: Number(page) } : undefined }), reload()));
  };

  if (!ids.length) return <Empty>Add and include sources first.</Empty>;
  return (
    <div>
      <div className="rsx-row">
        <select className="wb-select rsx-grow" value={sourceId} onChange={(e) => setSourceId(e.target.value)} aria-label="Source">{ids.map((id) => <option key={id} value={id}>{refLabel(project.sources[id], id)}: {project.sources[id]?.title?.slice(0, 80)}</option>)}</select>
      </div>
      <div className="rsx-row">
        <button className="wb-btn small" disabled={busy || !ref?.abstract} onClick={() => suggest("abstract")} title={ref?.abstract ? "" : "This source has no abstract"}>Suggest from abstract</button>
        <button className="wb-btn small" disabled={busy} onClick={() => suggest("page")} title="Reads the page in the current tab (for example the paper's HTML full text)">Suggest from current tab</button>
        <button className="wb-btn small" disabled={busy} onClick={() => setPaste(paste === undefined ? "" : undefined)}>Paste text…</button>
        <label className="rsx-muted"><input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} /> Also ask AI (optional; asks consent; suggestions must quote the text)</label>
      </div>
      {paste !== undefined && (
        <div className="wb-card">
          <textarea className="wb-input" style={{ width: "100%" }} rows={6} placeholder="Paste a section of the paper (e.g. from the PDF reader)" value={paste} onChange={(e) => setPaste(e.target.value)} />
          <div className="rsx-row end"><button className="wb-btn small primary" disabled={busy || paste.trim().length < 40} onClick={() => suggest("supplied-text", paste)}>Suggest from this text</button></div>
        </div>
      )}
      <FlashLine flash={flash} />
      <p className="rsx-muted">Suggestions only reach the matrix and outline after you accept them. Cue-phrase suggestions are a rough first pass.</p>
      <label className="rsx-muted"><input type="checkbox" checked={showRejected} onChange={(e) => setShowRejected(e.target.checked)} /> Show rejected</label>
      {EXTRACTION_FIELDS.map((field) => {
        const list = (items ?? []).filter((i) => i.field === field && (showRejected || i.status !== "rejected"));
        return (
          <div key={field}>
            <div className="rsx-row"><div className="rsx-section rsx-grow">{FIELD_LABELS[field]}</div><button className="wb-btn small" disabled={busy} onClick={() => addManual(field)}>+ Add</button></div>
            {list.map((i) => (
              <div key={i.id} className="rsx-item">
                <div className="rsx-row">
                  <span className={`rsx-tag ${i.status === "accepted" ? "ok" : i.status === "rejected" ? "bad" : i.origin === "ai" ? "ai" : "warn"}`}>{i.status}</span>
                  <span className="rsx-tag">{ORIGIN[i.origin]}</span>
                  {i.labels.map((l) => <span key={l} className="rsx-tag ai">{l}</span>)}
                  <span className="rsx-grow" />
                  {i.status !== "accepted" && <button className="wb-btn small primary" disabled={busy} onClick={() => update(i.id, { status: "accepted" })}>Accept</button>}
                  {i.status !== "rejected" && <button className="wb-btn small" disabled={busy} onClick={() => update(i.id, { status: "rejected" })}>Reject</button>}
                  <button className="wb-btn small" disabled={busy} onClick={() => { const t = prompt("Edit (your words)", i.text); if (t?.trim()) void update(i.id, { text: t }); }}>Edit</button>
                  <button className="wb-btn small" disabled={busy} onClick={() => { const t = prompt("Short labels for grouping, comma-separated (e.g. CNN, MIT-BIH)", i.labels.join(", ")); if (t !== null) void update(i.id, { labels: t.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 10) }); }}>Labels</button>
                  <select className="wb-select" value={i.field} aria-label="Move to field" onChange={(e) => update(i.id, { field: e.target.value })}>{EXTRACTION_FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f]}</option>)}</select>
                </div>
                <p>{i.text}</p>
                {i.quote && i.quote !== i.text && <div className="rsx-quote">“{i.quote}”</div>}
                {i.locator?.page && <span className="rsx-muted">p. {i.locator.page}</span>}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
