import { useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import type { LabProject } from "../../model.js";
import { screeningCountsOf } from "./util.js";
import { FlashLine, library, useAction, useLoad } from "../shared.js";
import { Sources } from "./Sources.js";
import { Questions } from "./Questions.js";
import { Extract } from "./Extract.js";
import { MatrixView } from "./Matrix.js";
import { Gaps } from "./Gaps.js";
import { OutlineView } from "./Outline.js";
import { GraphView } from "./Graph.js";

const TABS = [
  ["sources", "Sources & screening"],
  ["questions", "Questions & evidence"],
  ["extract", "Extraction"],
  ["matrix", "Matrix"],
  ["gaps", "Gaps"],
  ["graph", "Citation graph"],
  ["outline", "Outline & report"],
] as const;
type Tab = (typeof TABS)[number][0];

export function ProjectView({ api, id, onDeleted, onChanged }: { api: WorkbenchAppApi; id: string; onDeleted: () => void; onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>("sources");
  const [project, reload, err] = useLoad(() => api.invoke<LabProject>("projects.get", { id }), [id]);
  const { busy, flash, run } = useAction();
  if (err) return <FlashLine flash={{ kind: "error", text: err }} />;
  if (!project) return null;
  const changed = () => (reload(), onChanged());
  const c = screeningCountsOf(project);

  const rename = () => {
    const title = prompt("Review name", project.title);
    if (title?.trim()) void run(async () => (await api.invoke("projects.update", { id, title }), changed()));
  };
  const sync = () => run(async () => {
    const lib = await library.list(api);
    const r = await api.invoke<{ missing: string[] }>("projects.syncSources", { id, refs: lib.map((i) => i.ref) });
    changed();
    return r;
  }, (r) => (r.missing.length ? `Updated from the library. Not found in the library any more: ${r.missing.join(", ")} (kept in this review).` : "Updated source details from the library."));
  const exportFile = () => run(async () => api.download(`${project.title.replace(/[^\w\- ]+/g, "").slice(0, 60) || "review"}.aether-review.json`, await api.invoke<string>("projects.export", { id }), "application/json"));
  const del = () => confirm(`Delete “${project.title}” and its questions, evidence and extractions? Library references are kept.`) && run(async () => (await api.invoke("projects.delete", { id }), onDeleted()));

  return (
    <div>
      <div className="rsx-row">
        <h2 className="rsx-grow" style={{ margin: 0 }}>{project.title}</h2>
        <button className="wb-btn small" disabled={busy} onClick={rename}>Rename</button>
        <button className="wb-btn small" disabled={busy} onClick={sync} title="Refresh source details from the shared library">Sync with library</button>
        <button className="wb-btn small" disabled={busy} onClick={exportFile}>Export project file</button>
        <button className="wb-btn small danger" disabled={busy} onClick={del}>Delete</button>
      </div>
      <p className="rsx-muted">{c.identified} sources · {c.included} included · {c.excluded} excluded · {c.maybe} undecided · {c.unscreened} not screened</p>
      <FlashLine flash={flash} />
      <div className="rsx-tabs" role="tablist">
        {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === "sources" && <Sources api={api} project={project} onChanged={changed} />}
      {tab === "questions" && <Questions api={api} project={project} />}
      {tab === "extract" && <Extract api={api} project={project} />}
      {tab === "matrix" && <MatrixView api={api} project={project} onChanged={changed} />}
      {tab === "gaps" && <Gaps api={api} project={project} />}
      {tab === "graph" && <GraphView api={api} project={project} onChanged={changed} />}
      {tab === "outline" && <OutlineView api={api} project={project} />}
    </div>
  );
}
