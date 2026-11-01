import { useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import { SERVICE_INFO, type DiscoveryService, type LabSettings, type NetworkLogEntry } from "../../model.js";
import { FlashLine, useAction, useLoad } from "../shared.js";

type Settings = LabSettings & { keys: Record<"openalex" | "semanticscholar", boolean>; secretsAvailable: boolean; aiAvailable: boolean };

export function SettingsView({ api }: { api: WorkbenchAppApi }) {
  const [s, reload] = useLoad(() => api.invoke<Settings>("settings.get"), []);
  const [log, reloadLog] = useLoad(() => api.invoke<NetworkLogEntry[]>("net.log"), []);
  const [mailto, setMailto] = useState<string>();
  const { busy, flash, run } = useAction();
  if (!s) return null;
  const set = (patch: Record<string, unknown>) => run(async () => (await api.invoke("settings.set", patch), reload()));
  const setKey = (service: "openalex" | "semanticscholar") => {
    const key = prompt(`Paste your ${SERVICE_INFO[service].label} API key (leave empty to remove it). It is stored encrypted on this device.`);
    if (key === null) return;
    void run(async () => (await api.invoke("settings.setKey", { service, key }), reload()), () => (key ? "Key saved." : "Key removed."));
  };
  return (
    <div>
      <h2>Settings</h2>
      <FlashLine flash={flash} />
      <div className="wb-card">
        <label className="rsx-row">
          <input type="checkbox" checked={s.online} disabled={busy} onChange={(e) => set({ online: e.target.checked })} />
          <b>Use online scholarly services</b>
        </label>
        <p className="rsx-muted">Off by default. When on, searches, verification, citation graphs and timelines contact only the services below. Your library, projects, notes and saved pages always work offline.</p>
        <table className="wb-table">
          <thead><tr><th>Service</th><th>What is sent</th><th /></tr></thead>
          <tbody>
            {(Object.keys(SERVICE_INFO) as DiscoveryService[]).map((k) => (
              <tr key={k}>
                <td><label><input type="checkbox" checked={s.services[k]} disabled={busy} onChange={(e) => set({ services: { [k]: e.target.checked } })} /> {SERVICE_INFO[k].label}</label><div className="rsx-muted mono">{SERVICE_INFO[k].host}</div></td>
                <td className="rsx-muted">{SERVICE_INFO[k].sends}</td>
                <td>{(k === "openalex" || k === "semanticscholar") && s.secretsAvailable && <button className="wb-btn small" onClick={() => setKey(k)}>{s.keys[k] ? "Change API key" : "Add API key"}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="rsx-muted">Verification also uses doi.org (and the registries it redirects to: Crossref and DataCite). Google Scholar has no public API; AETHER only opens a Scholar search in a normal tab.</p>
        <form className="rsx-row" onSubmit={(e) => (e.preventDefault(), void set({ mailto: mailto ?? s.mailto ?? "" }))}>
          <label className="rsx-grow">Contact email for Crossref/OpenAlex “polite pool” (optional, sent with requests)
            <input className="wb-input" style={{ width: "100%" }} type="email" value={mailto ?? s.mailto ?? ""} onChange={(e) => setMailto(e.target.value)} />
          </label>
          <button className="wb-btn" disabled={busy}>Save</button>
        </form>
        <label className="rsx-row">Flag sources older than <input className="wb-input" type="number" min={1} max={100} style={{ width: 70 }} value={s.datedAfterYears} onChange={(e) => set({ datedAfterYears: Number(e.target.value) || 10 })} /> years (informational)</label>
        <p className="rsx-muted">AI suggestions: {s.aiAvailable ? "available when AI is on in AETHER Settings. Each use asks for consent per content type." : "off. Turn on AI in AETHER Settings to get optional AI suggestions; everything else works without it."}</p>
      </div>
      <div className="rsx-section">Network log (this session)</div>
      <div className="rsx-row"><button className="wb-btn small" onClick={reloadLog}>Refresh</button><button className="wb-btn small" onClick={() => run(async () => (await api.invoke("net.clearLog"), reloadLog()))}>Clear</button></div>
      {!log?.length ? <p className="rsx-muted">No requests sent.</p> : (
        <table className="wb-table">
          <thead><tr><th>Time</th><th>Host</th><th>Purpose</th><th>Sent</th><th>Status</th></tr></thead>
          <tbody>{log.map((e, i) => <tr key={i}><td>{new Date(e.at).toLocaleTimeString()}</td><td className="mono">{e.host}</td><td>{e.purpose}</td><td>{e.sent}</td><td>{String(e.status)} · {e.ms} ms</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
