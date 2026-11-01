import { useState } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import type { SavedPage } from "../model.js";
import { Empty, ExtLink, FlashLine, useAction, useLoad } from "./shared.js";

type SavedSummary = Omit<SavedPage, "text"> & { chars: number };
interface Hit { id: string; title: string; url: string; savedAt: string; snippet: string }

/** Offline library: save the current page (archive + text) and search everything saved, without a connection. */
export function LibraryApp({ api }: { api: WorkbenchAppApi }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>();
  const [open, setOpen] = useState<SavedPage>();
  const { busy, flash, run } = useAction();
  const [pages, reload, err] = useLoad(() => api.invoke<SavedSummary[]>("saved.list", {}), []);

  const save = () =>
    run(() => api.invoke<SavedSummary>("saved.add", {}), (r) => {
      reload();
      return r.archive ? `Saved “${r.title}” with an offline archive.` : `Saved the text of “${r.title}” (no archive available for this page).`;
    });
  const search = () => (query.trim() ? run(async () => setHits(await api.invoke<Hit[]>("saved.search", { query }))) : setHits(undefined));
  const view = (id: string) => run(async () => setOpen(await api.invoke<SavedPage>("saved.get", { id })));
  const archive = (id: string) => run(async () => {
    const a = await api.invoke<{ name: string; content: string }>("saved.archive", { id });
    api.download(a.name, a.content, "multipart/related");
  });
  const remove = (id: string) => run(async () => {
    await api.invoke("saved.delete", { id });
    if (open?.id === id) setOpen(undefined);
    reload();
  });

  if (open)
    return (
      <div className="wb-panel">
        <div className="rsx-row">
          <button className="wb-btn" onClick={() => setOpen(undefined)}>← Back</button>
          <span className="rsx-grow" />
          <ExtLink api={api} href={open.url}>Open live page</ExtLink>
          {open.archive && <button className="wb-btn" onClick={() => archive(open.id)}>Download archive</button>}
        </div>
        <h2>{open.title}</h2>
        <p className="rsx-muted">Saved {new Date(open.createdAt).toLocaleString()} from {open.url}. Offline text view.</p>
        <div className="rsx-reader">{open.text || "No readable text was captured."}</div>
      </div>
    );

  const list = hits ?? pages?.map((p) => ({ id: p.id, title: p.title, url: p.url, savedAt: p.createdAt, snippet: `${p.chars.toLocaleString()} characters${p.archive ? " · archive" : ""}` }));
  return (
    <div className="wb-panel">
      <h2>Offline Library</h2>
      <p className="rsx-muted">Pages you save stay on this device and are searchable without a connection. Pages are never saved from private windows.</p>
      <div className="rsx-row">
        <button className="wb-btn primary" disabled={busy || api.activeTab.isPrivate} onClick={save} title={api.activeTab.isPrivate ? "Not available in private windows" : "Save the page in the current tab"}>
          Save current page
        </button>
        <form className="rsx-row rsx-grow" onSubmit={(e) => (e.preventDefault(), void search())}>
          <input className="wb-input rsx-grow" placeholder="Search saved pages" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search saved pages" />
          <button className="wb-btn" disabled={busy}>Search</button>
          {hits && <button type="button" className="wb-btn" onClick={() => (setHits(undefined), setQuery(""))}>Clear</button>}
        </form>
      </div>
      <FlashLine flash={flash ?? (err ? { kind: "error", text: err } : undefined)} />
      {!list?.length ? (
        <Empty>{hits ? "No saved page matches." : "Nothing saved yet. Open a page and press Save current page."}</Empty>
      ) : (
        <div className="rsx-list">
          {list.map((h) => (
            <div key={h.id} className="rsx-item">
              <h4><button className="wb-link" onClick={() => view(h.id)}>{h.title}</button></h4>
              <p className="rsx-muted">{h.url} · {new Date(h.savedAt).toLocaleDateString()}</p>
              <p>{h.snippet}</p>
              <div className="rsx-row end"><button className="wb-btn small danger" onClick={() => remove(h.id)}>Delete</button></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
