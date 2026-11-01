import { useCallback, useEffect, useMemo, useState } from "react";
import type { PanelApi } from "@aether/plugin-api";
import type { Reference } from "@aether/citations";
import { TEMPLATES, type Paper } from "@aether/paper-editor";
import { PaperEditor, type AssistAction } from "@aether/paper-editor/ui";
import { downloadText, paperClient, runAi } from "./clients.js";

const GOAL: Record<AssistAction, string> = { "Grammar revision": "grammar", "Clarity revision": "clarity", "Make concise": "concise", "Formal register": "formal" };

/** Paper writer: pick or create a paper in this workspace, then edit it with live citations and checks. */
export function WriterPanel({ api }: { api: PanelApi }) {
  const ws = api.activeTab.workspaceId ?? undefined;
  const [papers, setPapers] = useState<Paper[]>([]);
  const [openId, setOpenId] = useState<string>();
  const [library, setLibrary] = useState<Map<string, Reference>>(new Map());
  const [aiEnabled, setAiEnabled] = useState(false);
  const [error, setError] = useState<string>();
  const client = useMemo(() => paperClient(api), [api]);

  const refresh = useCallback(async () => {
    setPapers(await api.invoke<Paper[]>("papers.list", { workspaceId: ws }));
    setLibrary(new Map((await api.invoke<Reference[]>("library.forPaper")).map((r) => [r.id, r])));
    setAiEnabled((await api.invoke<{ settings: { enabled: boolean } }>("ai.state")).settings.enabled);
  }, [api, ws]);

  useEffect(() => {
    void refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  if (openId) {
    return (
      <div className="ae-writer">
        <button onClick={() => (setOpenId(undefined), void refresh())}>← All papers</button>
        <PaperEditor
          paperId={openId}
          client={client}
          library={library}
          assist={aiEnabled ? async (text, action) => runAi(api, { task: "revise", text, goal: GOAL[action] }) : undefined}
          onExport={(f) => downloadText(f.name, f.content, f.mime)}
        />
      </div>
    );
  }

  return (
    <div className="ae-writer-list">
      {error && <p role="alert">{error}</p>}
      <h3>Papers in this workspace</h3>
      {papers.length === 0 ? <p className="ae-empty">No papers yet.</p> : (
        <ul>
          {papers.map((p) => (
            <li key={p.id}>
              <button onClick={() => setOpenId(p.id)}>
                <strong>{p.title}</strong> <small>{TEMPLATES.find((t) => t.id === p.templateId)?.name} · edited {new Date(p.updatedAt).toLocaleDateString()}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      <h3>Start a new paper</h3>
      <ul className="ae-templates">
        {TEMPLATES.map((t) => (
          <li key={t.id}>
            <button onClick={async () => {
              const p = await api.invoke<Paper>("papers.create", { templateId: t.id, title: t.id === "blank" ? "Untitled" : `New ${t.name.toLowerCase()}`, workspaceId: ws });
              setOpenId(p.id);
            }}>
              <strong>{t.name}</strong>
              <small>{t.description}</small>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
