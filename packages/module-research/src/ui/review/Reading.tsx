import { useMemo, useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import { TAG_FACETS, type ReadingItem, type ReadingStatus, type TagFacet } from "../../model.js";
import { Empty, FlashLine, library, refLabel, useAction, useLoad } from "../shared.js";

const STATUSES: ReadingStatus[] = ["queued", "reading", "read", "skipped"];

/** Reading queue and topic tags over the shared library. */
export function ReadingQueue({ api }: { api: WorkbenchAppApi }) {
  const [lib] = useLoad(() => library.list(api), []);
  const [items, reload] = useLoad(() => api.invoke<ReadingItem[]>("reading.list", {}), []);
  const [facets, reloadFacets] = useLoad(() => api.invoke<Record<string, Record<string, number>>>("reading.facets"), []);
  const [status, setStatus] = useState<ReadingStatus | "all">("queued");
  const [tagFilter, setTagFilter] = useState<{ facet: TagFacet; tag: string }>();
  const { busy, flash, run } = useAction();
  const byId = useMemo(() => new Map((lib ?? []).map((i) => [i.id, i])), [lib]);
  const set = (refId: string, patch: Record<string, unknown>) => run(async () => (await api.invoke("reading.set", { refId, ...patch }), reload(), reloadFacets()));
  const shown = (items ?? []).filter((r) => (status === "all" || r.status === status) && (!tagFilter || r.tags[tagFilter.facet]?.includes(tagFilter.tag)));
  const notQueued = (lib ?? []).filter((i) => !items?.some((r) => r.refId === i.id));
  const editTags = (r: ReadingItem, facet: TagFacet) => {
    const v = prompt(`${facet} tags, comma-separated`, (r.tags[facet] ?? []).join(", "));
    if (v !== null) void set(r.refId, { tags: { [facet]: v.split(",").map((x) => x.trim()).filter(Boolean) } });
  };
  return (
    <div>
      <h2>Reading queue</h2>
      <p className="rsx-muted">Queue papers from your library, mark what you have read, rate relevance and tag them by topic, methodology, domain, dataset and application. Works offline.</p>
      <FlashLine flash={flash} />
      <div className="wb-seg" role="tablist">
        {(["all", ...STATUSES] as const).map((s) => <button key={s} className={status === s ? "on" : ""} onClick={() => setStatus(s)}>{s}</button>)}
      </div>
      {facets && Object.keys(facets).length > 0 && (
        <div className="rsx-row">
          {Object.entries(facets).flatMap(([f, tags]) => Object.entries(tags).map(([t, n]) => (
            <button key={`${f}:${t}`} className={`rsx-tag ${tagFilter?.facet === f && tagFilter.tag === t ? "ai" : ""}`} onClick={() => setTagFilter(tagFilter?.tag === t && tagFilter.facet === f ? undefined : { facet: f as TagFacet, tag: t })}>{f}: {t} ({n})</button>
          )))}
        </div>
      )}
      {!shown.length ? <Empty>Nothing here.</Empty> : (
        <div className="rsx-list">
          {shown.map((r) => {
            const it = byId.get(r.refId);
            return (
              <div key={r.refId} className="rsx-item">
                <h4>{it?.ref.title ?? r.title ?? r.refId}</h4>
                <p className="rsx-muted">{refLabel(it?.ref, r.refId)}{!it && " · no longer in the library"}</p>
                <div className="rsx-row">
                  <select className="wb-select" value={r.status} onChange={(e) => set(r.refId, { status: e.target.value })} aria-label="Reading status">{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
                  <select className="wb-select" value={r.relevance} onChange={(e) => set(r.refId, { relevance: Number(e.target.value) })} aria-label="Relevance">
                    <option value={0}>Relevance: not rated</option><option value={1}>Low</option><option value={2}>Medium</option><option value={3}>High</option>
                  </select>
                  {TAG_FACETS.map((f) => <button key={f} className="wb-btn small" onClick={() => editTags(r, f)}>{f}{r.tags[f]?.length ? `: ${r.tags[f]!.join(", ")}` : ""}</button>)}
                  <button className="wb-btn small danger" disabled={busy} onClick={() => run(async () => (await api.invoke("reading.delete", { refId: r.refId }), reload(), reloadFacets()))}>Remove</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {notQueued.length > 0 && (
        <>
          <div className="rsx-section">In your library, not queued</div>
          <table className="wb-table"><tbody>
            {notQueued.slice(0, 200).map((i) => (
              <tr key={i.id}><td>{i.ref.title ?? i.id}<div className="rsx-muted">{refLabel(i.ref, i.id)}</div></td><td><button className="wb-btn small" disabled={busy} onClick={() => set(i.id, { title: i.ref.title })}>Queue</button></td></tr>
            ))}
          </tbody></table>
        </>
      )}
    </div>
  );
}
