import { useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import type { Reference } from "@aether/citations";
import type { LabProject } from "../../model.js";
import type { ReviewOutline } from "../../analysis.js";
import { FlashLine, library, useAction, useLoad } from "../shared.js";

/** Cited outline and full report, sent to the Writer or downloaded. */
export function OutlineView({ api, project }: { api: WorkbenchAppApi; project: LabProject }) {
  const [data] = useLoad(() => api.invoke<{ outline: ReviewOutline; markdown: string; references: Reference[] }>("outline.get", { projectId: project.id }), [project.id]);
  const [mode, setMode] = useState<"outline" | "report">("outline");
  const [report, setReport] = useState<string>();
  const { busy, flash, run } = useAction();

  const ensureInLibrary = async (refs: Reference[]) => {
    // The Writer resolves [@key] against the shared library, so make sure every cited key exists there.
    const lib = new Set((await library.list(api)).map((i) => i.id));
    const missing = refs.filter((r) => !lib.has(r.id));
    for (const r of missing) await library.add(api, r);
    return missing.length;
  };
  const toWriter = (title: string, markdown: string, refs: Reference[]) => run(async () => {
    const added = await ensureInLibrary(refs);
    const doc = await api.invokeModule<{ id: string }>("aether.writer", "createFromMarkdown", { title, markdown, template: "review" });
    api.openApp("writer", doc.id);
    return added;
  }, (added) => "Opened in the Writer." + (added ? " " + added + (added === 1 ? " reference was" : " references were") + " re-added to the library so citations resolve." : ""));
  const loadReport = () => run(async () => {
    const r = await api.invoke<{ markdown: string; references: Reference[] }>("projects.report", { id: project.id });
    setReport(r.markdown);
    return r;
  });

  const reportToWriter = () =>
    run(async () => {
      const r = await api.invoke<{ markdown: string; references: Reference[] }>("projects.report", { id: project.id });
      await toWriter(project.title + ": review report", r.markdown, r.references);
    });
  const cite = (cites: string[], locator?: string) => "[" + cites.map((c) => "@" + c).join("; ") + (locator ? ", " + locator : "") + "]";
  if (!data) return null;
  const o = data.outline;
  return (
    <div>
      <div className="rsx-row">
        <div className="wb-seg"><button className={mode === "outline" ? "on" : ""} onClick={() => setMode("outline")}>Outline</button><button className={mode === "report" ? "on" : ""} onClick={() => (setMode("report"), void loadReport())}>Full report</button></div>
        <span className="rsx-grow" />
        {mode === "outline" ? (
          <>
            <button className="wb-btn small primary" disabled={busy} onClick={() => toWriter(o.title, data.markdown, data.references)}>Open in Writer</button>
            <button className="wb-btn small" onClick={() => api.download("review-outline.md", data.markdown, "text/markdown")}>Download .md</button>
          </>
        ) : (
          report ? (
            <>
              <button className="wb-btn small primary" disabled={busy} onClick={reportToWriter}>Open in Writer</button>
              <button className="wb-btn small" onClick={() => api.download("review-report.md", report, "text/markdown")}>Download .md</button>
            </>
          ) : null
        )}
      </div>
      <FlashLine flash={flash} />
      {o.warnings.map((w, i) => <p key={i} className="danger">{w}</p>)}
      {mode === "outline" ? (
        <>
          <p className="rsx-muted">Built only from evidence you linked and extractions you accepted. Each point cites its source; TODOs show what is still missing. The Writer turns it into a document you rewrite in your own words, then exports to DOCX, PDF or LaTeX.</p>
          {o.sections.map((s, i) => (
            <div key={i} className="wb-card" style={{ marginBottom: 8 }}>
              <b>{s.heading}</b>
              <ul>{s.bullets.map((b, j) => <li key={j}>{b.text} <span className="rsx-muted mono">{cite(b.cites, b.locator)}</span></li>)}</ul>
              {s.todo.map((t, j) => <p key={j} className="rsx-muted">TODO: {t}</p>)}
            </div>
          ))}
        </>
      ) : (
        <div className="rsx-pre">{report ?? "Building report…"}</div>
      )}
    </div>
  );
}
