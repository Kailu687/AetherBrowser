import { useEffect, useMemo, useRef, useState } from "react";
import { Bibliography, type Reference } from "@aether/citations";
import { renderMarkdown } from "@aether/notebook";
import { useKatex } from "@aether/notebook/ui";
import type { Paper, Section } from "../model.js";
import { aiDisclosure, checkPaper, sectionStats, type Issue } from "../checks.js";
import { exportHtml, exportLatex, exportMarkdown, exportPandoc } from "../export.js";
import type { PaperStore } from "../store.js";

export type PaperClient = Pick<PaperStore, "get" | "update" | "updateSection" | "addSection" | "removeSection" | "moveSection" | "addReferences" | "snapshot" | "recordAi">;

export type AssistAction = "Grammar revision" | "Clarity revision" | "Make concise" | "Formal register";

export interface AssistResult {
  text: string;
  provider: string;
  model: string;
  auditId?: string;
}

export interface PaperEditorProps {
  paperId: string;
  client: PaperClient;
  library: Map<string, Reference>;
  /** Optional: provided only when the user has enabled AI. Returns revised text for review. */
  assist?: (text: string, action: AssistAction) => Promise<AssistResult>;
  /** Save an exported file (the shell shows a save dialog). */
  onExport?: (file: { name: string; mime: string; content: string }) => void;
  saveDelay?: number;
}

const ACTIONS: AssistAction[] = ["Grammar revision", "Clarity revision", "Make concise", "Formal register"];

export function PaperEditor({ paperId, client, library, assist, onExport, saveDelay = 500 }: PaperEditorProps) {
  const [paper, setPaper] = useState<Paper>();
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState<string>();
  const [panel, setPanel] = useState<"checks" | "references" | "ai" | null>("checks");

  useEffect(() => {
    client.get(paperId).then((p) => {
      if (!p) return setError("This paper no longer exists.");
      setPaper(p);
      setActiveId(p.sections.find((s) => s.kind === "body")?.id ?? p.sections[0]?.id);
    }, (e: Error) => setError(e.message));
  }, [client, paperId]);

  const issues = useMemo(() => (paper ? checkPaper(paper, library) : []), [paper, library]);
  if (error) return <p role="alert">{error}</p>;
  if (!paper) return <p aria-busy="true">Loading paper…</p>;
  const active = paper.sections.find((s) => s.id === activeId) ?? paper.sections[0];

  const apply = (p: Paper) => setPaper(structuredClone(p));
  const exportAs = (kind: "md" | "tex" | "bib" | "html" | "pandoc") => {
    const base = paper.title.replace(/[^\w\- ]+/g, "").trim() || "paper";
    if (kind === "md") onExport?.({ name: `${base}.md`, mime: "text/markdown", content: exportMarkdown(paper, library) });
    if (kind === "pandoc") onExport?.({ name: `${base}.pandoc.md`, mime: "text/markdown", content: exportPandoc(paper) });
    if (kind === "html") onExport?.({ name: `${base}.html`, mime: "text/html", content: exportHtml(paper, library) });
    if (kind === "tex" || kind === "bib") {
      const { tex, bib } = exportLatex(paper, library);
      onExport?.(kind === "tex" ? { name: "main.tex", mime: "application/x-tex", content: tex } : { name: "references.bib", mime: "application/x-bibtex", content: bib });
    }
  };

  return (
    <div className="ae-paper">
      <header className="ae-paper-header">
        <input aria-label="Paper title" className="ae-paper-title" value={paper.title} onChange={(e) => {
          setPaper({ ...paper, title: e.target.value });
          void client.update(paper.id, { title: e.target.value });
        }} />
        <select aria-label="Citation style" value={paper.style} onChange={async (e) => apply(await client.update(paper.id, { style: e.target.value as Paper["style"] }))}>
          <option value="ieee">IEEE</option>
          <option value="apa">APA 7</option>
          <option value="mla">MLA 9</option>
          <option value="chicago">Chicago</option>
        </select>
        <button onClick={async () => apply(await client.snapshot(paper.id, new Date().toLocaleString()))}>Save version</button>
        {onExport && (
          <select aria-label="Export" value="" onChange={(e) => exportAs(e.target.value as never)}>
            <option value="" disabled>Export…</option>
            <option value="tex">LaTeX (main.tex)</option>
            <option value="bib">BibTeX (references.bib)</option>
            <option value="md">Markdown</option>
            <option value="pandoc">Pandoc Markdown</option>
            <option value="html">HTML (print to PDF)</option>
          </select>
        )}
      </header>
      <div className="ae-paper-body">
        <nav aria-label="Outline" className="ae-outline">
          <ol>
            {paper.sections.map((s) => {
              const count = issues.filter((i) => i.sectionId === s.id && i.severity !== "info").length;
              return (
                <li key={s.id} style={{ paddingLeft: (s.level - 1) * 12 }}>
                  <button aria-current={s.id === active?.id} onClick={() => setActiveId(s.id)}>
                    {s.heading} {count > 0 && <span className="ae-badge" aria-label={`${count} issues`}>{count}</span>}
                  </button>
                </li>
              );
            })}
          </ol>
          <button onClick={async () => {
            const p = await client.addSection(paper.id, "New section", { after: active?.id });
            apply(p);
            setActiveId(p.sections[p.sections.findIndex((s) => s.id === active?.id) + 1]?.id);
          }}>+ Section</button>
        </nav>
        {active && (
          <SectionEditor
            key={active.id}
            paper={paper}
            section={active}
            library={library}
            saveDelay={saveDelay}
            onSave={async (body) => apply(await client.updateSection(paper.id, active.id, { body }))}
            onRename={async (heading) => apply(await client.updateSection(paper.id, active.id, { heading }))}
            onMove={async (d) => apply(await client.moveSection(paper.id, active.id, d))}
            onRemove={async () => {
              if (!globalThis.confirm?.(`Delete “${active.heading}”? You can restore it from a saved version.`)) return;
              const p = await client.removeSection(paper.id, active.id);
              apply(p);
              setActiveId(p.sections[0]?.id);
            }}
            assist={assist}
            onAssistDecision={async (c, body) => apply(await client.recordAi(paper.id, c, body))}
            onAddReference={async (id) => apply(await client.addReferences(paper.id, [id]))}
          />
        )}
        <aside className="ae-paper-side">
          <div role="tablist">
            <button role="tab" aria-selected={panel === "checks"} onClick={() => setPanel("checks")}>Checks ({issues.filter((i) => i.severity !== "info").length})</button>
            <button role="tab" aria-selected={panel === "references"} onClick={() => setPanel("references")}>References</button>
            <button role="tab" aria-selected={panel === "ai"} onClick={() => setPanel("ai")}>AI use</button>
          </div>
          {panel === "checks" && <ChecksList issues={issues} onJump={setActiveId} />}
          {panel === "references" && <ReferenceList paper={paper} library={library} />}
          {panel === "ai" && (
            <div className="ae-ai-use">
              <p>Every AI suggestion you accept or reject is recorded here so you can disclose AI use accurately.</p>
              <textarea readOnly aria-label="AI disclosure statement" value={aiDisclosure(paper)} rows={5} />
              <ul>
                {paper.aiLog.slice().reverse().map((c) => (
                  <li key={c.id}>
                    {new Date(c.at).toLocaleString()} · {c.action} · {paper.sections.find((s) => s.id === c.sectionId)?.heading ?? "removed section"} · {c.model} · {c.accepted ? "accepted" : "rejected"}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function SectionEditor(props: {
  paper: Paper;
  section: Section;
  library: Map<string, Reference>;
  saveDelay: number;
  onSave(body: string): Promise<void>;
  onRename(h: string): Promise<void>;
  onMove(d: -1 | 1): Promise<void>;
  onRemove(): Promise<void>;
  assist?: PaperEditorProps["assist"];
  onAssistDecision(c: Parameters<PaperClient["recordAi"]>[1], body?: string): Promise<void>;
  onAddReference(id: string): Promise<void>;
}) {
  const { paper, section, library } = props;
  const [body, setBody] = useState(section.body);
  const [heading, setHeading] = useState(section.heading);
  const [suggestion, setSuggestion] = useState<(AssistResult & { action: AssistAction; from: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [assistError, setAssistError] = useState<string>();
  const area = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(body);
  latest.current = body;
  const katex = useKatex(body);

  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      if (latest.current !== section.body) void props.onSave(latest.current);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (v: string) => {
    setBody(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void props.onSave(v), props.saveDelay);
  };

  const preview = useMemo(() => {
    const bib = new Bibliography(paper.style, library.values());
    // Number citations in document order up to this section so IEEE labels match the export.
    for (const s of paper.sections) {
      if (s.id === section.id) break;
      for (const m of s.body.matchAll(/@([\w:.#$%&\-+?<>~/]+)/g)) if (library.has(m[1]!)) bib.cite(m[1]!);
    }
    return renderMarkdown(body, { katex, resolveCitation: (k, loc) => (library.has(k) ? bib.cite(k, loc ? { locator: loc } : {}) : undefined) });
  }, [body, katex, library, paper.sections, paper.style, section.id]);

  const stats = sectionStats({ ...section, body });

  const insertCitation = (id: string) => {
    const el = area.current;
    const at = el?.selectionEnd ?? body.length;
    const next = `${body.slice(0, at)} [@${id}]${body.slice(at)}`;
    change(next);
    if (!paper.referenceIds.includes(id)) void props.onAddReference(id);
  };

  const runAssist = async (action: AssistAction) => {
    if (!props.assist) return;
    const el = area.current;
    const sel = el && el.selectionEnd > el.selectionStart ? body.slice(el.selectionStart, el.selectionEnd) : body;
    if (!sel.trim()) return;
    setBusy(true);
    setAssistError(undefined);
    try {
      setSuggestion({ ...(await props.assist(sel, action)), action, from: sel });
    } catch (e) {
      setAssistError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (accepted: boolean) => {
    if (!suggestion) return;
    const next = accepted ? body.replace(suggestion.from, suggestion.text) : undefined;
    await props.onAssistDecision(
      { sectionId: section.id, action: suggestion.action, provider: suggestion.provider, model: suggestion.model, auditId: suggestion.auditId, accepted, charsBefore: suggestion.from.length, charsAfter: suggestion.text.length },
      next,
    );
    if (next !== undefined) setBody(next);
    setSuggestion(null);
  };

  return (
    <main className="ae-section-editor">
      <div className="ae-section-head">
        <input aria-label="Section heading" value={heading} onChange={(e) => setHeading(e.target.value)} onBlur={() => heading !== section.heading && void props.onRename(heading)} />
        <button aria-label="Move section up" onClick={() => props.onMove(-1)}>↑</button>
        <button aria-label="Move section down" onClick={() => props.onMove(1)}>↓</button>
        <button aria-label="Delete section" onClick={() => props.onRemove()}>Delete</button>
      </div>
      <div className="ae-section-tools">
        <select aria-label="Insert citation" value="" onChange={(e) => insertCitation(e.target.value)}>
          <option value="" disabled>Cite…</option>
          {[...library.values()].map((r) => (
            <option key={r.id} value={r.id}>{r.id} — {r.title?.slice(0, 60)}</option>
          ))}
        </select>
        {props.assist &&
          ACTIONS.map((a) => (
            <button key={a} disabled={busy} onClick={() => runAssist(a)} title="Suggests a revision of the selection (or whole section) for you to review">
              {a}
            </button>
          ))}
        <span className="ae-stats">{stats.words} words{section.targetWords ? ` (target ${section.targetWords[0]}–${section.targetWords[1]})` : ""} · reading ease {Math.round(stats.fleschReadingEase)}</span>
      </div>
      {assistError && <p role="alert">{assistError}</p>}
      {suggestion && (
        <div className="ae-suggestion" role="dialog" aria-label="AI suggestion">
          <p>
            Suggested by {suggestion.model} ({suggestion.action}). Review before accepting; citations and numbers should be unchanged.
          </p>
          <div className="ae-diff">
            <del>{suggestion.from}</del>
            <ins>{suggestion.text}</ins>
          </div>
          <button onClick={() => decide(true)}>Accept</button>
          <button onClick={() => decide(false)}>Reject</button>
        </div>
      )}
      <div className="ae-split">
        <textarea ref={area} aria-label={`${section.heading} text`} placeholder={section.hint} value={body} onChange={(e) => change(e.target.value)} spellCheck />
        <div className="ae-preview markdown-body" data-testid="section-preview" dangerouslySetInnerHTML={{ __html: preview }} />
      </div>
    </main>
  );
}

function ChecksList({ issues, onJump }: { issues: Issue[]; onJump(id: string): void }) {
  if (!issues.length) return <p>No issues found.</p>;
  const order = { error: 0, warning: 1, info: 2 };
  return (
    <ul className="ae-checks">
      {[...issues].sort((a, b) => order[a.severity] - order[b.severity]).map((i, n) => (
        <li key={n} className={`ae-${i.severity}`}>
          <button disabled={!i.sectionId} onClick={() => i.sectionId && onJump(i.sectionId)}>
            <strong>{i.severity}</strong> {i.message}
            {i.excerpt && <q>{i.excerpt}</q>}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ReferenceList({ paper, library }: { paper: Paper; library: Map<string, Reference> }) {
  const bib = new Bibliography(paper.style, paper.referenceIds.map((id) => library.get(id)).filter((r): r is Reference => !!r));
  const entries = bib.entries(true);
  if (!entries.length) return <p>No references yet. Use “Cite…” to add one from your library.</p>;
  return (
    <ol className="ae-reflist">
      {entries.map((e) => (
        <li key={e.id} dangerouslySetInnerHTML={{ __html: `${e.label ? `${e.label} ` : ""}${e.html}` }} />
      ))}
    </ol>
  );
}
