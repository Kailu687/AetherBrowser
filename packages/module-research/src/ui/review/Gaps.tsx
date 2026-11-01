import type { WorkbenchAppApi } from "@aether/plugin-api";
import type { LabProject } from "../../model.js";
import type { GapHypothesis } from "../../analysis.js";
import { Empty, FlashLine, refLabel, useAction, useLoad } from "../shared.js";

type Gap = GapHypothesis & { decision?: "kept" | "dismissed"; note?: string };
const KIND: Record<GapHypothesis["kind"], string> = {
  "uncovered-combination": "Untested combination",
  "unanswered-question": "Unanswered question",
  "thin-evidence": "Thin evidence",
  contested: "Disagreement",
  "shared-limitation": "Shared limitation",
  "stated-future-work": "Authors' future work",
  "dated-evidence": "Dated evidence",
};

/** Gap hypotheses with the exact sources they rest on. The user keeps or dismisses each. */
export function Gaps({ api, project }: { api: WorkbenchAppApi; project: LabProject }) {
  const [gaps, reload] = useLoad(() => api.invoke<Gap[]>("gaps.list", { projectId: project.id }), [project.id]);
  const { busy, flash, run } = useAction();
  const decide = (g: Gap, status: "kept" | "dismissed" | null) => run(async () => (await api.invoke("gaps.decide", { projectId: project.id, key: g.key, status }), reload()));
  const shown = (gaps ?? []).filter((g) => g.decision !== "dismissed");
  const dismissed = (gaps ?? []).filter((g) => g.decision === "dismissed");
  return (
    <div>
      <p className="rsx-muted">
        These are hypotheses computed from your accepted extractions (their labels), your questions and your evidence. They describe only the sources in this review. Kept gaps go into the outline and report, marked as hypotheses. Search further before claiming a gap in the literature.
      </p>
      <FlashLine flash={flash} />
      {!shown.length ? <Empty>No gap hypotheses yet. Accept extractions (add labels to methods and datasets) and link evidence to questions.</Empty> : (
        <div className="rsx-list">
          {shown.map((g) => (
            <div key={g.key} className="rsx-item">
              <div className="rsx-row">
                <span className="rsx-tag">{KIND[g.kind]}</span>
                <span className={`rsx-tag ${g.strength === "moderate" ? "warn" : ""}`}>{g.strength}</span>
                {g.decision === "kept" && <span className="rsx-tag ok">kept</span>}
                <span className="rsx-grow" />
                {g.decision !== "kept" && <button className="wb-btn small primary" disabled={busy} onClick={() => decide(g, "kept")}>Keep</button>}
                {g.decision === "kept" && <button className="wb-btn small" disabled={busy} onClick={() => decide(g, null)}>Undo</button>}
                <button className="wb-btn small" disabled={busy} onClick={() => decide(g, "dismissed")}>Dismiss</button>
              </div>
              <p>{g.statement}</p>
              <p className="rsx-muted">Based on: {[...new Set(g.basis.map((b) => b.sourceId).filter((s): s is string => !!s))].map((s) => refLabel(project.sources[s], s)).join("; ") || "your questions"}</p>
              {g.basis.filter((b) => b.quote).slice(0, 3).map((b, i) => <div key={i} className="rsx-quote">“{b.quote}”</div>)}
              <p className="rsx-muted"><i>{g.caveat}</i></p>
            </div>
          ))}
        </div>
      )}
      {dismissed.length > 0 && (
        <details><summary className="rsx-muted">{dismissed.length} dismissed</summary>{dismissed.map((g) => <p key={g.key}>{g.statement} <button className="wb-link" onClick={() => decide(g, null)}>Restore</button></p>)}</details>
      )}
    </div>
  );
}
