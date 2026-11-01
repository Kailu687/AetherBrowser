import { useCallback, useEffect, useState } from "react";
import type { PanelApi } from "@aether/plugin-api";
import { SCOPE_LABELS, type AuditEntry, type ConsentGrant, type GatewaySettings, type ProviderInfo } from "@aether/ai";
import { runAi } from "./clients.js";
import type { ProviderConfig } from "../main/index.js";

interface AiState {
  settings: GatewaySettings;
  providers: ProviderInfo[];
  grants: ConsentGrant[];
  audit: AuditEntry[];
  configs: ProviderConfig[];
  keysPersisted: boolean;
}

/**
 * Optional assistant. Off by default; when on, shows exactly which provider
 * is used, what it may receive, and a log of every request.
 */
export function AssistantPanel({ api }: { api: PanelApi }) {
  const [state, setState] = useState<AiState>();
  const [input, setInput] = useState("");
  const [answer, setAnswer] = useState<{ text: string; model: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => setState(await api.invoke<AiState>("ai.state")), [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!state) return <p aria-busy="true">Loading…</p>;

  const set = async (patch: Partial<GatewaySettings>) => {
    await api.invoke("ai.updateSettings", patch);
    await refresh();
  };

  const run = async (payload: Record<string, unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await runAi(api, payload);
      setAnswer({ text: r.text, model: r.model });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <div className="ae-assistant">
      <label className="ae-toggle">
        <input type="checkbox" checked={state.settings.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        Enable AI assistance (off by default; AETHER works fully without it)
      </label>
      {state.settings.enabled && (
        <>
          {state.providers.length === 0 ? <ProviderSetup api={api} onDone={refresh} keysPersisted={state.keysPersisted} /> : (
            <div className="ae-row">
              <select aria-label="AI provider" value={state.settings.activeProvider} onChange={(e) => set({ activeProvider: e.target.value })}>
                {state.providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.label} — {p.kind === "local" ? "on this device" : `cloud (${p.host})`}</option>
                ))}
              </select>
            </div>
          )}
          <form onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) void run({ task: "explain", text: input });
          }}>
            <textarea aria-label="Ask the assistant" rows={3} placeholder="Paste text to explain, or ask about a concept" value={input} onChange={(e) => setInput(e.target.value)} />
            <div className="ae-row">
              <button type="submit" disabled={busy || !input.trim()}>Explain</button>
              <button type="button" disabled={busy || !input.trim()} onClick={() => run({ task: "summarize", text: input, scope: "selection" })}>Summarise</button>
            </div>
          </form>
          {error && <p role="alert">{error}</p>}
          {answer && (
            <div className="ae-answer" aria-live="polite">
              <small>Answer from {answer.model}. Check facts against your sources.</small>
              <p style={{ whiteSpace: "pre-wrap" }}>{answer.text}</p>
            </div>
          )}
          <details>
            <summary>Privacy controls</summary>
            <label className="ae-toggle"><input type="checkbox" checked={state.settings.redactCloud} onChange={(e) => set({ redactCloud: e.target.checked })} /> Mask emails, phone numbers and keys before sending to cloud models</label>
            <label className="ae-toggle"><input type="checkbox" checked={state.settings.confirmLocal} onChange={(e) => set({ confirmLocal: e.target.checked })} /> Ask before sending to local models too</label>
            <h4>Permissions</h4>
            {state.grants.length === 0 ? <p>No provider has permission to receive your content yet.</p> : (
              <ul>
                {state.grants.map((g) => (
                  <li key={g.providerId}>
                    {g.providerId}: {g.scopes.map((s) => SCOPE_LABELS[s]).join(", ")}
                    <button onClick={async () => (await api.invoke("ai.revoke", { providerId: g.providerId }), refresh())}>Revoke</button>
                  </li>
                ))}
              </ul>
            )}
            <h4>Request log</h4>
            <p><small>Metadata only: AETHER does not store what you sent.</small></p>
            <ul className="ae-audit">
              {state.audit.slice(0, 30).map((a) => (
                <li key={a.id}>{new Date(a.at).toLocaleString()} · {a.purpose} · {a.host} · {a.inputChars} chars · {a.outcome}{a.redactions ? ` · ${a.redactions} masked` : ""}</li>
              ))}
            </ul>
            <button onClick={async () => (await api.invoke("ai.clearAudit"), refresh())}>Clear log</button>
            <ProviderSetup api={api} onDone={refresh} keysPersisted={state.keysPersisted} compact />
          </details>
        </>
      )}
    </div>
  );
}

function ProviderSetup({ api, onDone, keysPersisted, compact }: { api: PanelApi; onDone(): void; keysPersisted: boolean; compact?: boolean }) {
  const [type, setType] = useState<ProviderConfig["type"]>("ollama");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434");
  const [model, setModel] = useState("llama3.2");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string>();
  const presets: Record<ProviderConfig["type"], { baseUrl: string; model: string }> = {
    ollama: { baseUrl: "http://127.0.0.1:11434", model: "llama3.2" },
    "openai-compatible": { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model" },
    anthropic: { baseUrl: "", model: "claude-opus-5-5" },
  };
  return (
    <form className="ae-provider-setup" onSubmit={async (e) => {
      e.preventDefault();
      setError(undefined);
      try {
        await api.invoke("ai.configureProvider", { id: type === "openai-compatible" ? "local-openai" : type, type, baseUrl: baseUrl || undefined, model, apiKey: apiKey || undefined });
        setApiKey("");
        onDone();
      } catch (err) {
        setError((err as Error).message);
      }
    }}>
      {!compact && <p>Choose where AI requests go. Local models keep everything on this computer.</p>}
      <select aria-label="Provider type" value={type} onChange={(e) => {
        const t = e.target.value as ProviderConfig["type"];
        setType(t);
        setBaseUrl(presets[t].baseUrl);
        setModel(presets[t].model);
      }}>
        <option value="ollama">Ollama (local)</option>
        <option value="openai-compatible">LM Studio / llama.cpp / other OpenAI-compatible server</option>
        <option value="anthropic">Anthropic Claude (cloud, your API key)</option>
      </select>
      {type !== "anthropic" && <input aria-label="Server URL" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />}
      <input aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} />
      {type !== "ollama" && <input aria-label="API key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={type === "anthropic" ? "sk-ant-…" : "optional"} />}
      {type !== "ollama" && !keysPersisted && <small>Keys are kept in memory only until AETHER restarts.</small>}
      <button type="submit">Save provider</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
