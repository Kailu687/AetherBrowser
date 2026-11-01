import { AiError, httpError, isLoopback, type AiProvider, type CompletionRequest, type CompletionResult, type FetchLike, type ProviderInfo } from "../types.js";
import { lines } from "../sse.js";

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
}

/** Ollama (https://ollama.com) running on this machine. */
export class OllamaProvider implements AiProvider {
  readonly info: ProviderInfo;
  private readonly base: string;
  private readonly f: FetchLike;

  constructor(opts: OllamaOptions = {}) {
    this.base = (opts.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.info = {
      id: "ollama",
      label: "Ollama",
      kind: isLoopback(this.base) ? "local" : "cloud",
      host: new URL(this.base).host,
      defaultModel: opts.model ?? "llama3.2",
    };
  }

  private body(req: CompletionRequest, stream: boolean) {
    const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages];
    return JSON.stringify({ model: req.model ?? this.info.defaultModel, messages, stream, options: req.maxTokens ? { num_predict: req.maxTokens } : undefined });
  }

  private async post(req: CompletionRequest, stream: boolean) {
    try {
      const res = await this.f(`${this.base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: this.body(req, stream), signal: req.signal });
      if (!res.ok) throw httpError(res.status, await res.text(), this.info.host);
      return res;
    } catch (e) {
      if (e instanceof AiError) throw e;
      if ((e as Error).name === "AbortError") throw new AiError("Request cancelled.", "aborted");
      throw new AiError(`Couldn't reach Ollama at ${this.info.host}. Is it running?`, "unavailable", e);
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await this.post(req, false);
    const j = (await res.json()) as { message?: { content?: string }; model?: string; prompt_eval_count?: number; eval_count?: number };
    return { text: j.message?.content ?? "", provider: this.info.id, model: j.model ?? req.model ?? this.info.defaultModel, usage: { inputTokens: j.prompt_eval_count, outputTokens: j.eval_count } };
  }

  async stream(req: CompletionRequest, onText: (s: string) => void): Promise<CompletionResult> {
    const res = await this.post(req, true);
    if (!res.body) return this.complete(req);
    let text = "";
    let usage: CompletionResult["usage"];
    for await (const line of lines(res.body)) {
      if (!line.trim()) continue;
      const j = JSON.parse(line) as { message?: { content?: string }; done?: boolean; prompt_eval_count?: number; eval_count?: number; error?: string };
      if (j.error) throw new AiError(j.error, "bad-request");
      const chunk = j.message?.content ?? "";
      if (chunk) {
        text += chunk;
        onText(chunk);
      }
      if (j.done) usage = { inputTokens: j.prompt_eval_count, outputTokens: j.eval_count };
    }
    return { text, provider: this.info.id, model: req.model ?? this.info.defaultModel, usage };
  }

  async listModels(): Promise<string[]> {
    const res = await this.f(`${this.base}/api/tags`, {});
    if (!res.ok) return [];
    const j = (await res.json()) as { models?: Array<{ name: string }> };
    return j.models?.map((m) => m.name) ?? [];
  }

  async available(): Promise<boolean> {
    try {
      return (await this.f(`${this.base}/api/tags`, {})).ok;
    } catch {
      return false;
    }
  }
}
