import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { Note } from "../model.js";
import { toggleTask } from "../model.js";
import { hasMath, loadKatex, renderMarkdown, type KatexLike, type RenderOptions } from "../render.js";
import type { SearchHit } from "../search.js";
import type { NewNote } from "../store.js";

/** What the panel needs; `Notebook` implements it directly, and the shell can proxy it over IPC. */
export interface NotebookClient {
  list(opts?: { workspaceId?: string | null }): Promise<Note[]>;
  search(query: string, opts?: { workspaceId?: string }): Promise<SearchHit[]>;
  get(id: string): Promise<Note | undefined>;
  create(input: NewNote): Promise<Note>;
  update(id: string, patch: Partial<Note>): Promise<Note>;
  delete(id: string): Promise<boolean>;
  capture(text: string, opts?: { workspaceId?: string; source?: { url: string; title?: string } }): Promise<Note>;
}

export interface NotesPanelProps {
  client: NotebookClient;
  workspaceId?: string;
  activeTab?: { url: string; title?: string };
  resolveCitation?: RenderOptions["resolveCitation"];
  /** Autosave delay in ms. */
  saveDelay?: number;
}

/** Hook: KaTeX is fetched only once a note actually contains math. */
export function useKatex(src: string): KatexLike | undefined {
  const [katex, setKatex] = useState<KatexLike>();
  const needs = hasMath(src);
  useEffect(() => {
    if (!needs || katex) return;
    let live = true;
    loadKatex().then((k) => live && setKatex(k), () => undefined);
    return () => {
      live = false;
    };
  }, [needs, katex]);
  return katex;
}

export function NotesPanel({ client, workspaceId, activeTab, resolveCitation, saveDelay = 400 }: NotesPanelProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [current, setCurrent] = useState<Note | null>(null);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setNotes(await client.list({ workspaceId }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!query.trim()) return setHits(null);
    let live = true;
    client.search(query, { workspaceId }).then((h) => live && setHits(h), (e) => setError(String(e)));
    return () => {
      live = false;
    };
  }, [client, query, workspaceId]);

  const newNote = async () => {
    const n = await client.create({ body: "# New note\n\n", workspaceId });
    await refresh();
    setCurrent(n);
  };

  if (current) {
    return (
      <NoteEditor
        key={current.id}
        note={current}
        client={client}
        saveDelay={saveDelay}
        resolveCitation={resolveCitation}
        onClose={() => {
          setCurrent(null);
          void refresh();
        }}
        onOpenLink={async (title) => {
          const found = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
          setCurrent(found ?? (await client.create({ body: `# ${title}\n\n`, workspaceId })));
        }}
      />
    );
  }

  const shown = hits ? hits.map((h) => ({ note: h.note, snippet: h.snippet })) : notes.map((n) => ({ note: n, snippet: "" }));
  return (
    <div className="ae-notes">
      {error && (
        <p role="alert" className="ae-error">
          {error}
        </p>
      )}
      <QuickCapture onCapture={async (text) => {
        await client.capture(text, { workspaceId, source: activeTab });
        await refresh();
      }} />
      <div className="ae-notes-toolbar">
        <input type="search" aria-label="Search notes" placeholder="Search notes or #tag" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button onClick={newNote}>New note</button>
      </div>
      {shown.length === 0 ? (
        <p className="ae-empty">{hits ? "No matching notes." : "No notes in this workspace yet."}</p>
      ) : (
        <ul className="ae-note-list">
          {shown.map(({ note, snippet }) => (
            <li key={note.id}>
              <button onClick={() => setCurrent(note)}>
                <strong>{note.title}</strong>
                {snippet && <span className="ae-snippet">{snippet}</span>}
                {note.tags.length > 0 && <span className="ae-tags">{note.tags.map((t) => `#${t}`).join(" ")}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function QuickCapture({ onCapture }: { onCapture: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="ae-capture"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim() || busy) return;
        setBusy(true);
        try {
          await onCapture(text);
          setText("");
        } finally {
          setBusy(false);
        }
      }}
    >
      <input aria-label="Quick capture" placeholder="Capture a thought…" value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit" disabled={busy || !text.trim()}>
        Save
      </button>
    </form>
  );
}

export interface NoteEditorProps {
  note: Note;
  client: NotebookClient;
  onClose(): void;
  onOpenLink?(title: string): void;
  resolveCitation?: RenderOptions["resolveCitation"];
  saveDelay?: number;
}

export function NoteEditor({ note, client, onClose, onOpenLink, resolveCitation, saveDelay = 400 }: NoteEditorProps) {
  const [body, setBody] = useState(note.body);
  const [status, setStatus] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  const [mode, setMode] = useState<"split" | "edit" | "preview">("split");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(body);
  latest.current = body;
  const katex = useKatex(body);
  const html = useMemo(() => renderMarkdown(body, { katex, resolveCitation }), [body, katex, resolveCitation]);

  const save = useCallback(async () => {
    setStatus("saving");
    try {
      await client.update(note.id, { body: latest.current });
      setStatus("saved");
    } catch {
      setStatus("error");
    }
  }, [client, note.id]);

  const change = (next: string) => {
    setBody(next);
    setStatus("dirty");
    clearTimeout(timer.current);
    timer.current = setTimeout(save, saveDelay);
  };

  // Flush pending edits when the editor closes so nothing typed is lost.
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        if (latest.current !== note.body) void client.update(note.id, { body: latest.current });
      }
    },
    [client, note.id, note.body],
  );

  const onPreviewClick = (e: MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.classList.contains("task")) {
      change(toggleTask(latest.current, Number(t.dataset.line)));
    } else if (t.classList.contains("wikilink")) {
      e.preventDefault();
      onOpenLink?.(t.dataset.note ?? "");
    }
  };

  return (
    <div className={`ae-note-editor mode-${mode}`}>
      <header>
        <button onClick={onClose} aria-label="Back to notes">
          ←
        </button>
        <span className="ae-save-status" aria-live="polite">
          {status === "saved" ? "Saved" : status === "saving" ? "Saving…" : status === "error" ? "Save failed — retrying on next edit" : "Edited"}
        </span>
        <div role="group" aria-label="View">
          {(["edit", "split", "preview"] as const).map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m}
            </button>
          ))}
        </div>
      </header>
      {mode !== "preview" && (
        <textarea
          aria-label="Note text"
          value={body}
          spellCheck
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "s") {
              e.preventDefault();
              clearTimeout(timer.current);
              void save();
            }
          }}
        />
      )}
      {mode !== "edit" && (
        // Rendered with html:false and KaTeX trust:false, so this markup contains no author-controlled HTML.
        <div className="ae-preview markdown-body" data-testid="preview" onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
