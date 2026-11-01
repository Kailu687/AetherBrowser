import { useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import type { LabProject } from "../model.js";
import { FlashLine, useAction, useLoad } from "./shared.js";
import { Discover } from "./review/Discover.js";
import { ReadingQueue } from "./review/Reading.js";
import { SettingsView } from "./review/Settings.js";
import { ProjectView } from "./review/Project.js";

type ProjectSummary = Pick<LabProject, "id" | "title" | "description" | "updatedAt"> & { sources: number; counts: { included: number; unscreened: number } };
type View = { kind: "discover" } | { kind: "reading" } | { kind: "settings" } | { kind: "project"; id: string };

/** Literature Review workspace: discovery, reading queue and review projects. */
export function ReviewApp({ api }: { api: WorkbenchAppApi }) {
  const [view, setView] = useState<View>(api.arg ? { kind: "project", id: api.arg } : { kind: "discover" });
  const [projects, reload] = useLoad(() => api.invoke<ProjectSummary[]>("projects.list", { workspaceId: api.activeTab.workspaceId ?? undefined }), []);
  const { busy, flash, run } = useAction();

  const create = () => {
    const title = prompt("Name the review (e.g. “Low-power ECG front ends”)");
    if (!title?.trim()) return;
    void run(async () => {
      const p = await api.invoke<LabProject>("projects.create", { title, workspaceId: api.activeTab.workspaceId ?? undefined });
      reload();
      setView({ kind: "project", id: p.id });
    });
  };
  const importFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 50_000_000) return alert("That file is too large.");
      void run(async () => {
        const p = await api.invoke<LabProject>("projects.import", { text: await f.text(), workspaceId: api.activeTab.workspaceId ?? undefined });
        reload();
        setView({ kind: "project", id: p.id });
      }, () => "Project imported.");
    };
    input.click();
  };
  const item = (v: View, label: string, sub?: string) => (
    <button key={v.kind === "project" ? v.id : v.kind} className={`wb-side-item ${JSON.stringify(v) === JSON.stringify(view) ? "on" : ""}`} onClick={() => setView(v)}>
      {label}
      {sub && <div className="rsx-muted">{sub}</div>}
    </button>
  );
  return (
    <div className="wb-split-view">
      <nav className="wb-side" aria-label="Literature review">
        <h5>Find</h5>
        {item({ kind: "discover" }, "🔎 Discover papers")}
        {item({ kind: "reading" }, "📖 Reading queue")}
        <h5>Reviews</h5>
        {projects?.map((p) => item({ kind: "project", id: p.id }, p.title, `${p.sources} sources · ${p.counts.included} included${p.counts.unscreened ? ` · ${p.counts.unscreened} to screen` : ""}`))}
        <div className="rsx-row" style={{ padding: "0 12px" }}>
          <button className="wb-btn small primary" disabled={busy} onClick={create}>New review</button>
          <button className="wb-btn small" disabled={busy} onClick={importFile}>Import</button>
        </div>
        <h5>Module</h5>
        {item({ kind: "settings" }, "⚙ Settings and network log")}
        <FlashLine flash={flash} />
      </nav>
      <main className="wb-content">
        {view.kind === "discover" && <Discover api={api} projects={projects ?? []} onProjectsChanged={reload} />}
        {view.kind === "reading" && <ReadingQueue api={api} />}
        {view.kind === "settings" && <SettingsView api={api} />}
        {view.kind === "project" && <ProjectView key={view.id} api={api} id={view.id} onDeleted={() => (reload(), setView({ kind: "discover" }))} onChanged={reload} />}
      </main>
    </div>
  );
}
