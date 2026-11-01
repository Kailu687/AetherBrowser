import { useCallback, useEffect, useState } from "react";
import type { PanelApi } from "@aether/plugin-api";
import type { StyleId } from "@aether/citations";
import { downloadText } from "./clients.js";
import type { LibraryItem, ResearchSettings } from "../main/index.js";

interface Formatted {
  id: string;
  label: string;
  text: string;
  html: string;
  inText: string;
}

/** Reference library: cite the current page, look up DOIs/arXiv, import BibTeX/RIS, copy formatted citations. */
export function LibraryPanel({ api }: { api: PanelApi }) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [formatted, setFormatted] = useState<Map<string, Formatted>>(new Map());
  const [style, setStyle] = useState<StyleId>("ieee");
  const [settings, setSettings] = useState<ResearchSettings>();
  const [identifier, setIdentifier] = useState("");
  const [filter, setFilter] = useState("");
  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string }>();
  const [busy, setBusy] = useState(false);
  const ws = api.activeTab.workspaceId ?? undefined;

  const refresh = useCallback(async () => {
    const list = await api.invoke<LibraryItem[]>("library.list", { workspaceId: ws });
    setItems(list);
    const f = await api.invoke<Formatted[]>("library.format", { style });
    setFormatted(new Map(f.map((x) => [x.id, x])));
  }, [api, style, ws]);

  useEffect(() => {
    api.invoke<ResearchSettings>("settings.get").then((s) => {
      setSettings(s);
      setStyle(s.defaultStyle);
    }, () => undefined);
  }, [api]);
  useEffect(() => {
    void refresh().catch((e: Error) => setMessage({ kind: "error", text: e.message }));
  }, [refresh]);

  const act = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setMessage(undefined);
    try {
      const text = await fn();
      if (text) setMessage({ kind: "info", text });
      await refresh();
    } catch (e) {
      setMessage({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const shown = items.filter((i) => !filter || `${i.ref.title} ${i.ref.author?.map((a) => a.family ?? a.literal).join(" ")} ${i.id}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="ae-library">
      <div className="ae-row">
        <button disabled={busy || api.activeTab.isPrivate === undefined} onClick={() => act(async () => {
          const r = await api.invoke<{ item: LibraryItem; warnings: string[] }>("library.captureTab");
          return [`Added “${r.item.ref.title ?? r.item.id}”.`, ...r.warnings].join(" ");
        })}>
          Cite this page
        </button>
        <select aria-label="Citation style" value={style} onChange={(e) => setStyle(e.target.value as StyleId)}>
          <option value="ieee">IEEE</option>
          <option value="apa">APA 7</option>
          <option value="mla">MLA 9</option>
          <option value="chicago">Chicago</option>
        </select>
      </div>
      <form className="ae-row" onSubmit={(e) => {
        e.preventDefault();
        if (identifier.trim()) void act(async () => {
          const item = await api.invoke<LibraryItem>("library.lookup", { identifier, workspaceId: ws });
          setIdentifier("");
          return `Added “${item.ref.title}”.`;
        });
      }}>
        <input aria-label="DOI or arXiv ID" placeholder={settings?.onlineLookups ? "DOI or arXiv ID" : "DOI lookup is off (see below)"} value={identifier} onChange={(e) => setIdentifier(e.target.value)} disabled={!settings?.onlineLookups} />
        <button type="submit" disabled={busy || !settings?.onlineLookups}>Add</button>
      </form>
      <label className="ae-toggle">
        <input type="checkbox" checked={!!settings?.onlineLookups} onChange={async (e) => setSettings(await api.invoke("settings.set", { onlineLookups: e.target.checked }))} />
        Look up DOIs and arXiv IDs online (sends only the identifier to Crossref or arXiv)
      </label>
      <details>
        <summary>Import BibTeX / RIS</summary>
        <ImportBox onImport={(format, text) => act(async () => {
          const r = await api.invoke<{ added: string[]; errors: Array<{ message: string }> }>("library.import", { format, text, workspaceId: ws });
          return `Imported ${r.added.length} reference${r.added.length === 1 ? "" : "s"}${r.errors.length ? `; skipped ${r.errors.length} malformed entr${r.errors.length === 1 ? "y" : "ies"}` : ""}.`;
        })} />
      </details>
      {message && <p role={message.kind === "error" ? "alert" : "status"} className={`ae-${message.kind}`}>{message.text}</p>}
      <div className="ae-row">
        <input type="search" aria-label="Filter references" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={async () => downloadText("references.bib", await api.invoke<string>("library.export", { format: "bibtex" }), "application/x-bibtex")}>Export .bib</button>
      </div>
      {shown.length === 0 ? (
        <p className="ae-empty">No references yet. Open a paper and press “Cite this page”.</p>
      ) : (
        <ul className="ae-refs">
          {shown.map((i) => {
            const f = formatted.get(i.id);
            return (
              <li key={i.id}>
                <div dangerouslySetInnerHTML={{ __html: f?.html ?? i.ref.title ?? i.id }} />
                <div className="ae-row ae-small">
                  <code>@{i.id}</code>
                  <button onClick={() => void navigator.clipboard.writeText(f?.text ?? "")}>Copy</button>
                  <button onClick={() => void navigator.clipboard.writeText(f?.inText ?? "")}>Copy in-text</button>
                  <button onClick={() => void navigator.clipboard.writeText(`[@${i.id}]`)}>Copy key</button>
                  {(i.pdfUrl ?? i.ref.URL) && <button onClick={() => api.openUrl(i.pdfUrl ?? i.ref.URL!)}>Open</button>}
                  <button aria-label={`Delete ${i.id}`} onClick={() => globalThis.confirm(`Remove @${i.id} from your library?`) && act(async () => void (await api.invoke("library.delete", { id: i.id })))}>Remove</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ImportBox({ onImport }: { onImport(format: "bibtex" | "ris", text: string): void }) {
  const [text, setText] = useState("");
  const format = /^\s*TY {2}- /m.test(text) ? "ris" : "bibtex";
  return (
    <div>
      <textarea aria-label="Paste BibTeX or RIS" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="@article{key, title={...}, ...}" />
      <input type="file" accept=".bib,.ris,.txt" aria-label="Import file" onChange={async (e) => setText(await e.target.files?.[0]?.text() ?? "")} />
      <button disabled={!text.trim()} onClick={() => {
        onImport(format, text);
        setText("");
      }}>Import {format === "ris" ? "RIS" : "BibTeX"}</button>
    </div>
  );
}
