import { useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import type { LabSettings, TrailEntry } from "../model.js";
import { Empty, FlashLine, library, useAction, useLoad } from "./shared.js";

/** Opt-in research trail: pages visited per workspace, without query strings, auto-deleted. */
export function TrailApp({ api }: { api: WorkbenchAppApi }) {
  const [q, setQ] = useState("");
  const [allWs, setAllWs] = useState(false);
  const { busy, flash, run } = useAction();
  const [settings, reloadSettings] = useLoad(() => api.invoke<LabSettings>("settings.get"), []);
  const ws = allWs ? undefined : (api.activeTab.workspaceId ?? undefined);
  const [items, reload] = useLoad(() => api.invoke<TrailEntry[]>("trail.list", { workspaceId: ws, query: q || undefined }), [ws, q]);

  const toggle = () => run(async () => {
    await api.invoke("settings.set", { trail: !settings?.trail });
    reloadSettings();
  });
  const byDay = new Map<string, TrailEntry[]>();
  for (const t of items ?? []) {
    const d = new Date(t.lastVisit).toLocaleDateString();
    byDay.set(d, [...(byDay.get(d) ?? []), t]);
  }
  return (
    <div className="wb-panel">
      <h2>Research Trail</h2>
      <p className="rsx-muted">
        When on, AETHER keeps a list of the pages you open in this profile ({settings?.trailDays ?? 30} days, then deleted). It stores the address without query strings or fragments, never records private windows, and stays on this device.
      </p>
      <div className="rsx-row">
        <button className={`wb-btn ${settings?.trail ? "" : "primary"}`} disabled={busy || !settings} onClick={toggle}>{settings?.trail ? "Turn trail off" : "Turn trail on"}</button>
        <label className="rsx-muted"><input type="checkbox" checked={allWs} onChange={(e) => setAllWs(e.target.checked)} /> All workspaces</label>
        <input className="wb-input rsx-grow" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter trail" />
        <button className="wb-btn danger" disabled={busy || !items?.length} onClick={() => confirm("Delete the whole trail for this profile?") && run(async () => (await api.invoke("trail.clear"), reload()))}>Clear trail</button>
      </div>
      <FlashLine flash={flash} />
      {!items?.length ? (
        <Empty>{settings?.trail ? "No pages recorded yet in this workspace." : "The trail is off."}</Empty>
      ) : (
        [...byDay].map(([day, list]) => (
          <div key={day}>
            <div className="rsx-section">{day}</div>
            <table className="wb-table">
              <tbody>
                {list.map((t) => (
                  <tr key={t.id}>
                    <td><button className="wb-link" onClick={() => api.openUrl(t.url)}>{t.title}</button><div className="rsx-muted">{t.url}</div></td>
                    <td className="rsx-muted">{t.visits}×</td>
                    <td>
                      <button className="wb-btn small" title="Add a webpage reference to the shared library" onClick={() => run(() => library.add(api, { id: "", type: "webpage", title: t.title, URL: t.url, accessed: { "date-parts": [[new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate()]] } }), () => "Added to the library as a web page. Add authors and a date there if the page has them.")}>Add to library</button>{" "}
                      <button className="wb-btn small danger" onClick={() => run(async () => (await api.invoke("trail.delete", { id: t.id }), reload()))}>Remove</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  );
}
