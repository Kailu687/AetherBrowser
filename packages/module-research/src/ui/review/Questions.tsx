import { useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import type { Evidence, ExtractionItem, LabProject, QuestionStatus, ResearchQuestion, Stance } from "../../model.js";
import { Empty, FlashLine, refLabel, useAction, useLoad } from "../shared.js";
import { includedIds } from "./util.js";

const STANCES: Stance[] = ["supports", "contradicts", "mixed", "context"];
const STATUSES: QuestionStatus[] = ["open", "investigating", "answered", "parked"];

export function Questions({ api, project }: { api: WorkbenchAppApi; project: LabProject }) {
  const [qs, reloadQ] = useLoad(() => api.invoke<ResearchQuestion[]>("questions.list", { projectId: project.id }), [project.id]);
  const [ev, reloadE] = useLoad(() => api.invoke<Evidence[]>("evidence.list", { projectId: project.id }), [project.id]);
  const [items] = useLoad(() => api.invoke<ExtractionItem[]>("extract.list", { projectId: project.id }), [project.id]);
  const [text, setText] = useState("");
  const [refine, setRefine] = useState<{ id: string; checklist: Array<{ check: string; ok: boolean; tip: string }>; suggestions: string[] }>();
  const { busy, flash, run } = useAction();
  const add = (parentId?: string, t = text) => run(async () => (await api.invoke("questions.create", { projectId: project.id, text: t, parentId }), setText(""), reloadQ()));
  const top = (qs ?? []).filter((q) => !q.parentId);

  const QuestionCard = ({ q, depth }: { q: ResearchQuestion; depth: number }) => {
    const mine = (ev ?? []).filter((e) => e.questionId === q.id);
    return (
      <div className="rsx-item" style={{ marginLeft: depth * 18 }}>
        <div className="rsx-row">
          <h4 className="rsx-grow" style={{ margin: 0 }}>{q.text}</h4>
          <select className="wb-select" value={q.status} aria-label="Question status" onChange={(e) => run(async () => (await api.invoke("questions.update", { id: q.id, status: e.target.value }), reloadQ()))}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
          <button className="wb-btn small" disabled={busy} onClick={() => run(async () => setRefine({ id: q.id, ...(await api.invoke<{ checklist: Array<{ check: string; ok: boolean; tip: string }>; suggestions: string[] }>("questions.refine", { id: q.id, useAi: false })) }))}>Refine</button>
          {depth === 0 && <button className="wb-btn small" disabled={busy} onClick={() => { const t = prompt("Sub-question"); if (t?.trim()) void add(q.id, t); }}>+ Sub-question</button>}
          <button className="wb-btn small danger" disabled={busy} onClick={() => confirm("Delete this question and its evidence?") && run(async () => (await api.invoke("questions.delete", { id: q.id }), reloadQ(), reloadE()))}>Delete</button>
        </div>
        {refine?.id === q.id && (
          <div className="wb-card">
            <ul>{refine.checklist.map((c) => <li key={c.check}>{c.ok ? "✓" : "○"} {c.check}{!c.ok && <span className="rsx-muted"> · {c.tip}</span>}</li>)}</ul>
            {refine.suggestions.length > 0 && <><b>AI suggestions</b> <span className="rsx-tag ai">AI</span><ul>{refine.suggestions.map((s) => <li key={s}>{s} <button className="wb-link" onClick={() => run(async () => (await api.invoke("questions.update", { id: q.id, text: s }), reloadQ(), setRefine(undefined)))}>Use</button></li>)}</ul></>}
            <div className="rsx-row">
              <button className="wb-btn small" disabled={busy} onClick={() => run(async () => setRefine({ id: q.id, ...(await api.invoke<{ checklist: Array<{ check: string; ok: boolean; tip: string }>; suggestions: string[]; aiUsed: boolean }>("questions.refine", { id: q.id, useAi: true })) }), () => undefined)}>Ask AI for rewordings</button>
              <button className="wb-btn small" onClick={() => { const t = prompt("Edit question", q.text); if (t?.trim()) void run(async () => (await api.invoke("questions.update", { id: q.id, text: t }), reloadQ())); }}>Edit</button>
              <button className="wb-btn small" onClick={() => setRefine(undefined)}>Close</button>
            </div>
          </div>
        )}
        {mine.map((e) => (
          <div key={e.id} style={{ margin: "6px 0" }}>
            <span className={`rsx-tag ${e.stance === "supports" ? "ok" : e.stance === "contradicts" ? "bad" : e.stance === "mixed" ? "warn" : ""}`}>{e.stance}</span>
            {e.claim} <span className="rsx-muted">· {refLabel(project.sources[e.sourceId], e.sourceId)}{e.locator?.page ? `, p. ${e.locator.page}` : ""}</span>
            <button className="wb-icon small danger" aria-label="Delete evidence" onClick={() => run(async () => (await api.invoke("evidence.delete", { id: e.id }), reloadE()))}>✕</button>
            {e.quote && <div className="rsx-quote">“{e.quote}”</div>}
          </div>
        ))}
        <EvidenceForm api={api} project={project} question={q} items={items ?? []} onAdded={reloadE} />
        {(qs ?? []).filter((c) => c.parentId === q.id).map((c) => <QuestionCard key={c.id} q={c} depth={depth + 1} />)}
      </div>
    );
  };

  return (
    <div>
      <p className="rsx-muted">Track what you are trying to answer. Evidence must come from a source in this review and keeps its quote and page so every claim stays traceable.</p>
      <form className="rsx-row" onSubmit={(e) => (e.preventDefault(), text.trim() && void add())}>
        <input className="wb-input rsx-grow" placeholder="Add a research question" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="wb-btn primary" disabled={busy || !text.trim()}>Add</button>
      </form>
      <FlashLine flash={flash} />
      {!top.length ? <Empty>No questions yet.</Empty> : <div className="rsx-list">{top.map((q) => <QuestionCard key={q.id} q={q} depth={0} />)}</div>}
    </div>
  );
}

function EvidenceForm({ api, project, question, items, onAdded }: { api: WorkbenchAppApi; project: LabProject; question: ResearchQuestion; items: ExtractionItem[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ sourceId: "", stance: "supports" as Stance, claim: "", quote: "", page: "", extractionId: "" });
  const { busy, flash, run } = useAction();
  const ids = includedIds(project);
  if (!open) return <button className="wb-btn small" onClick={() => setOpen(true)}>+ Evidence</button>;
  const fromItems = items.filter((i) => i.sourceId === f.sourceId && i.status === "accepted");
  return (
    <div className="wb-card">
      <div className="wb-form">
        <label>Source<select className="wb-select" value={f.sourceId} onChange={(e) => setF({ ...f, sourceId: e.target.value, extractionId: "" })}><option value="">Choose…</option>{ids.map((id) => <option key={id} value={id}>{refLabel(project.sources[id], id)}</option>)}</select></label>
        <label>Stance<select className="wb-select" value={f.stance} onChange={(e) => setF({ ...f, stance: e.target.value as Stance })}>{STANCES.map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>Page<input className="wb-input" inputMode="numeric" value={f.page} onChange={(e) => setF({ ...f, page: e.target.value.replace(/\D/g, "").slice(0, 6) })} /></label>
        {fromItems.length > 0 && <label>From extraction<select className="wb-select" value={f.extractionId} onChange={(e) => { const it = fromItems.find((x) => x.id === e.target.value); setF({ ...f, extractionId: e.target.value, claim: f.claim || it?.text || "", quote: it?.quote ?? f.quote }); }}><option value="">None</option>{fromItems.map((i) => <option key={i.id} value={i.id}>{i.field}: {i.text.slice(0, 60)}</option>)}</select></label>}
      </div>
      <label className="rsx-muted">What the source says (your words)<textarea className="wb-input" style={{ width: "100%" }} rows={2} value={f.claim} onChange={(e) => setF({ ...f, claim: e.target.value })} /></label>
      <label className="rsx-muted">Quote (optional, copied exactly)<textarea className="wb-input" style={{ width: "100%" }} rows={2} value={f.quote} onChange={(e) => setF({ ...f, quote: e.target.value })} /></label>
      <FlashLine flash={flash} />
      <div className="rsx-row end">
        <button className="wb-btn small" onClick={() => setOpen(false)}>Cancel</button>
        <button className="wb-btn small primary" disabled={busy || !f.sourceId || !f.claim.trim()} onClick={() => run(async () => {
          await api.invoke("evidence.create", { projectId: project.id, questionId: question.id, sourceId: f.sourceId, stance: f.stance, claim: f.claim, quote: f.quote || undefined, locator: f.page ? { page: Number(f.page) } : undefined, extractionId: f.extractionId || undefined });
          setF({ sourceId: f.sourceId, stance: "supports", claim: "", quote: "", page: "", extractionId: "" });
          setOpen(false);
          onAdded();
        })}>Add evidence</button>
      </div>
    </div>
  );
}
