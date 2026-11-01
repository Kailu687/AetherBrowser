import { lazy, Suspense, useMemo, type ComponentType } from "react";
import type { AetherRendererModule, PanelApi } from "@aether/plugin-api";
import { MODULE_ID } from "../main/constants.js";

/**
 * Each panel's code (and heavy deps like KaTeX, markdown-it) loads only when
 * the user first opens it, keeping browser start-up light.
 */
function lazyPanel(load: () => Promise<ComponentType<{ api: PanelApi }>>): ComponentType<{ api: PanelApi }> {
  const L = lazy(async () => ({ default: await load() }));
  return function Panel(props: { api: PanelApi }) {
    return (
      <Suspense fallback={<p aria-busy="true" className="ae-loading">Loading…</p>}>
        <L {...props} />
      </Suspense>
    );
  };
}

const NotesPanel = lazyPanel(async () => {
  const [{ NotesPanel: Inner }, { notebookClient }] = await Promise.all([import("@aether/notebook/ui"), import("./clients.js")]);
  return function Notes({ api }: { api: PanelApi }) {
    const client = useMemo(() => notebookClient(api), [api]);
    const tab = api.activeTab;
    return <Inner client={client} workspaceId={tab.workspaceId ?? undefined} activeTab={tab.url ? { url: tab.url, title: tab.title } : undefined} />;
  };
});

export const researchRendererModule: AetherRendererModule = {
  id: MODULE_ID,
  panels: [
    { id: "notebook", title: "Notebook", icon: "✎", component: NotesPanel, width: 420 },
    { id: "library", title: "Library", icon: "\u{1F4DA}", component: lazyPanel(async () => (await import("./LibraryPanel.js")).LibraryPanel), width: 400 },
    { id: "writer", title: "Writer", icon: "\u{1F4DD}", component: lazyPanel(async () => (await import("./WriterPanel.js")).WriterPanel), width: 760 },
    { id: "calculator", title: "Calculator", icon: "∑", component: lazyPanel(async () => (await import("@aether/calculators/ui")).CalculatorPanel as never), width: 360 },
    { id: "assistant", title: "Assistant", icon: "✦", component: lazyPanel(async () => (await import("./AssistantPanel.js")).AssistantPanel), width: 380 },
  ],
};
