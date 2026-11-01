import { useEffect, useMemo, useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import type { Reference } from "@aether/citations";
import type { FieldDiff, LabSettings, VerificationRecord } from "../model.js";
import type { QualityReport } from "../quality.js";
import { Empty, FlashLine, OnlineBadge, library, refLabel, useAction, useLoad, type LibraryItem } from "./shared.js";

const STATUS: Record<VerificationRecord["status"], { label: string; cls: string }> = {
  verified: { label: "Verified", cls: "ok" },
  mismatch: { label: "Mismatch", cls: "warn" },
  "not-found": { label: "Identifier does not resolve", cls: "bad" },
  candidate: { label: "Likely DOI found", cls: "warn" },
  unmatched: { label: "No confident match", cls: "" },
  error: { label: "Check failed", cls: "" },
  offline: { label: "Offline", cls: "" },
};

/** Reference Check: verify the shared library against registries and show an offline citation-quality report. */
export function VerifyApp({ api }: { api: WorkbenchAppApi }) {
  const { busy, flash, run } = useAction();
  const [items, reloadLib] = useLoad(() => library.list(api), []);
  const [records, setRecords] = useState<Map<string, VerificationRecord>>(new Map());
  const [report, setReport] = useState<QualityReport>();
  const [progress, setProgress] = useState<string>();
  const [settings] = useLoad(() => api.invoke<LabSettings>("settings.get"), []);
  const refs = useMemo(() => (items ?? []).map((i) => i.ref), [items]);

  const refreshRecords = async () => {
    const list = await api.invoke<VerificationRecord[]>("verify.list", {});
    setRecords(new Map(list.map((r) => [r.refId, r])));
  };
  const refreshReport = async () => setReport(await api.invoke<QualityReport>("quality.report", { refs }));
  useEffect(() => {
    if (items) void run(async () => (await refreshRecords(), await refreshReport()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  useEffect(() => api.on("verify.progress", (p) => {
    const x = p as { done: number; total: number };
    setProgress(`${x.done} of ${x.total} checked`);
  }), [api]);

  const verify = (list: Reference[]) =>
    run(async () => {
      const out = await api.invoke<VerificationRecord[]>("verify.run", { refs: list });
      setProgress(undefined);
      await refreshRecords();
      await refreshReport();
      return out;
    }, (out) => (out.some((r) => r.status === "offline") ? "Online features are off. Turn them on in Literature Review → Settings to verify." : `Checked ${out.length} reference${out.length === 1 ? "" : "s"}.`));

  const apply = (item: LibraryItem, fields: FieldDiff["field"][]) =>
    run(async () => {
      const fixed = await api.invoke<Reference>("verify.corrected", { ref: item.ref, fields });
      await library.update(api, item, fixed);
      reloadLib();
    }, () => `Updated ${item.id} with the registry's ${fields.join(", ")}.`);

  const findings = (id: string) => report?.findings.filter((f) => f.refId === id) ?? [];
  return (
    <div className="wb-panel">
      <h2>Reference Check</h2>
      <p className="rsx-muted">
        Checks each reference in your shared library against Crossref, doi.org and arXiv, including retraction and correction notices <OnlineBadge />. The quality report below works offline. Nothing in your library changes unless you apply a correction.
      </p>
      <div className="rsx-row">
        <button className="wb-btn primary" disabled={busy || !refs.length} onClick={() => verify(refs)}>Verify all ({refs.length})</button>
        <button className="wb-btn" disabled={busy || !refs.length} onClick={() => verify(refs.filter((r) => !records.has(r.id)))}>Verify unchecked</button>
        {!settings?.online && <span className="rsx-tag warn">Online features are off</span>}
        {progress && <span className="rsx-muted">{progress}</span>}
      </div>
      <FlashLine flash={flash} />
      {report && (
        <div className="rsx-counts">
          <div className="rsx-count"><b>{report.total}</b><small>references</small></div>
          <div className="rsx-count"><b>{report.verified}</b><small>verified</small></div>
          <div className="rsx-count"><b className="danger">{report.counts.error}</b><small>errors</small></div>
          <div className="rsx-count"><b>{report.counts.warning}</b><small>warnings</small></div>
          <div className="rsx-count"><b>{report.counts.info}</b><small>notes</small></div>
        </div>
      )}
      {!items?.length ? (
        <Empty>Your library is empty. Add references from Literature Review or the Library panel.</Empty>
      ) : (
        <div className="rsx-list">
          {items.map((it) => {
            const rec = records.get(it.id);
            const f = findings(it.id);
            return (
              <div key={it.id} className="rsx-item">
                <h4>{it.ref.title ?? it.id}</h4>
                <p className="rsx-muted">
                  {refLabel(it.ref, it.id)} · <span className="mono">{it.id}</span>
                  {it.ref.DOI ? ` · doi:${it.ref.DOI}` : ""}
                </p>
                <div>
                  {rec ? <span className={`rsx-tag ${STATUS[rec.status].cls}`}>{STATUS[rec.status].label}</span> : <span className="rsx-tag">Not checked</span>}
                  {rec?.notices.map((n, i) => <span key={i} className="rsx-tag bad">{n.label} ({n.source})</span>)}
                  {rec && <span className="rsx-muted"> {rec.message} Checked {new Date(rec.checkedAt).toLocaleDateString()}.</span>}
                </div>
                {rec && rec.diffs.length > 0 && <Diffs rec={rec} onApply={(fields) => apply(it, fields)} busy={busy} />}
                {rec?.status === "candidate" && rec.candidate?.DOI && !rec.diffs.length && (
                  <div className="rsx-row"><button className="wb-btn small" disabled={busy} onClick={() => apply(it, ["DOI"])}>Add DOI {rec.candidate.DOI}</button></div>
                )}
                {f.length > 0 && (
                  <ul className="rsx-muted">
                    {f.map((x, i) => <li key={i} className={x.severity === "error" ? "danger" : ""}>{x.message}</li>)}
                  </ul>
                )}
                <div className="rsx-row end"><button className="wb-btn small" disabled={busy} onClick={() => verify([it.ref])}>Check</button></div>
              </div>
            );
          })}
        </div>
      )}
      {report && (
        <>
          {report.findings.filter((x) => x.code === "cited-not-in-library").map((x, i) => <p key={i} className="danger">{x.message}</p>)}
          <div className="rsx-section">What this does not check</div>
          <ul className="rsx-muted">{report.limits.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </>
      )}
    </div>
  );
}

function Diffs({ rec, onApply, busy }: { rec: VerificationRecord; onApply: (f: FieldDiff["field"][]) => void; busy: boolean }) {
  const [pick, setPick] = useState<Set<FieldDiff["field"]>>(new Set());
  const fields = rec.status === "candidate" && rec.candidate?.DOI ? [...rec.diffs, { field: "DOI" as const, ours: "", registry: rec.candidate.DOI, severity: "warning" as const }] : rec.diffs;
  return (
    <>
      <table className="wb-table rsx-diff">
        <thead><tr><th /><th>Field</th><th>Your reference</th><th>Registry ({rec.registry})</th></tr></thead>
        <tbody>
          {fields.map((d) => (
            <tr key={d.field}>
              <td><input type="checkbox" aria-label={`Use registry ${d.field}`} checked={pick.has(d.field)} onChange={(e) => { const n = new Set(pick); if (e.target.checked) n.add(d.field); else n.delete(d.field); setPick(n); }} /></td>
              <td>{d.field}{d.severity === "error" && <span className="rsx-tag bad">major</span>}</td>
              <td>{d.ours || "—"}</td>
              <td>{d.registry}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rsx-row"><button className="wb-btn small" disabled={busy || !pick.size} onClick={() => onApply([...pick])}>Use registry values for selected fields</button><span className="rsx-muted">A major mismatch often means the DOI belongs to a different paper: fix the DOI rather than copying fields.</span></div>
    </>
  );
}
