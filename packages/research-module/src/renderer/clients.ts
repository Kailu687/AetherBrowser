import type { PanelApi } from "@aether/plugin-api";
import type { NotebookClient } from "@aether/notebook/ui";
import type { PaperClient } from "@aether/paper-editor/ui";

/** Notebook API proxied to the main-process module. */
export function notebookClient(api: PanelApi): NotebookClient {
  return {
    list: (opts) => api.invoke("notes.list", opts ?? {}),
    search: (query, opts) => api.invoke("notes.search", { query, ...opts }),
    get: (id) => api.invoke("notes.get", { id }),
    create: (input) => api.invoke("notes.create", input),
    update: (id, patch) => api.invoke("notes.update", { id, patch }),
    delete: (id) => api.invoke("notes.delete", { id }),
    capture: (text, opts) => api.invoke("notes.capture", { text, ...opts }),
  };
}

export function paperClient(api: PanelApi): PaperClient {
  return {
    get: (id) => api.invoke("papers.get", { id }),
    update: (id, patch) => api.invoke("papers.update", { id, patch }),
    updateSection: (id, sectionId, patch) => api.invoke("papers.updateSection", { id, sectionId, patch }),
    addSection: (id, heading, opts) => api.invoke("papers.addSection", { id, heading, ...opts }),
    removeSection: (id, sectionId) => api.invoke("papers.removeSection", { id, sectionId }),
    moveSection: (id, sectionId, delta) => api.invoke("papers.moveSection", { id, sectionId, delta }),
    addReferences: (id, refIds) => api.invoke("papers.addReferences", { id, refIds }),
    snapshot: (id, label) => api.invoke("papers.snapshot", { id, label }),
    recordAi: (id, contribution, body) => api.invoke("papers.recordAi", { id, contribution, body }),
  } as PaperClient;
}

/** Save text as a file through the browser's download flow (the shell's download manager handles it). */
export function downloadText(name: string, content: string, mime = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type AiRunResponse =
  | { ok: true; result: { text: string; provider: string; model: string; auditId: string } }
  | { ok: false; kind: string; message: string; detail?: { providerId: string; providerLabel: string; host: string; kind: "local" | "cloud"; purpose: string; missingScopes: string[]; scopeLabels: string[]; characters: number } };

/**
 * Run an AI task, asking for consent in a native confirm dialog when the
 * gateway requires it. Returns the text, or throws with a readable message.
 */
export async function runAi(api: PanelApi, payload: Record<string, unknown>, ask: (msg: string) => boolean = (m) => globalThis.confirm(m)): Promise<{ text: string; provider: string; model: string; auditId: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await api.invoke<AiRunResponse>("ai.run", payload);
    if (r.ok) return r.result;
    if (r.kind !== "consent-required" || !r.detail) throw new Error(r.message);
    const d = r.detail;
    const where = d.kind === "local" ? `your local model (${d.host})` : `${d.providerLabel} at ${d.host} (leaves this device)`;
    const ok = ask(`“${d.purpose}” will send about ${d.characters.toLocaleString()} characters to ${where}:\n\n• ${d.scopeLabels.join("\n• ")}\n\nAllow this for ${d.providerLabel}? You can revoke it any time in the Assistant panel.`);
    if (!ok) throw new Error("Cancelled: nothing was sent.");
    await api.invoke("ai.grant", { providerId: d.providerId, scopes: d.missingScopes });
  }
  throw new Error("Consent could not be recorded.");
}
