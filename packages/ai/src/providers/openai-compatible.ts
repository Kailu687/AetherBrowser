import { AiError, httpError, isLoopback, type AiProvider, type CompletionRequest, type CompletionResult, type FetchLike, type ProviderInfo } from "../types.js";
import { sseData } from "../sse.js";

export interface OpenAICompatibleOptions {
  id?: string;
  label?: string;
  /** e.g. http://127.0.0.1:1234/v1 (LM Studio), http://127.0.0.1:8080/v1 (llama.cpp server), or a hosted endpoint. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetch?: FetchLike;
}

/**
 * Any server speaking the /v1/chat/completions protocol: LM Studio, llama.cpp,
 * vLLM, Jan, or a hosted service the user configures with their own key.
 */
export class OpenAICompatibleProvider implements AiProvider {
  readonly info: ProviderInfo;
  private readonly f: FetchLike;
  private readonly base: string;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.f = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
    const local = isLoopback(this.base);
    this.info = {
      id: opts.id ?? (local ? "local-openai" : "openai-compatible"),
      label: opts.label ?? (local ? "Local server" : new URL(this.base).host),
      kind: local ? "local" : "cloud",
      host: new URL(this.base).host,
      defaultModel: opts.model,
    };
  }

  private async post(req: CompletionRequest, stream: boolean) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages];
    try {
      const res = await this.f(`${this.base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: req.model ?? this.info.defaultModel, messages, max_tokens: req.maxTokens, stream }),
        signal: req.signal,
      });
      if (!res.ok) throw httpError(res.status, await res.text(), this.info.host);
      return res;
    } catch (e) {
      if (e instanceof AiError) throw e;
      if ((e as Error).name === "AbortError") throw new AiError("Request cancelled.", "aborted");
      throw new AiError(`Couldn't reach ${this.info.host}.`, "unavailable", e);
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await this.post(req, false);
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const c = j.choices?.[0];
    return {
      text: c?.message?.content ?? "",
      provider: this.info.id,
      model: j.model ?? req.model ?? this.info.defaultModel,
      usage: { inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens },
      refused: c?.finish_reason === "content_filter" || undefined,
    };
  }

  async stream(req: CompletionRequest, onText: (s: string) => void): Promise<CompletionResult> {
    const res = await this.post(req, true);
    if (!res.body) return this.complete(req);
    let text = "";
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      const j = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
      const chunk = j.choices?.[0]?.delta?.content ?? "";
      if (chunk) {
        text += chunk;
        onText(chunk);
      }
    }
    return { text, provider: this.info.id, model: req.model ?? this.info.defaultModel };
  }

  async listModels(): Promise<string[]> {
    const headers: Record<string, string> = this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {};
    const res = await this.f(`${this.base}/models`, { headers });
    if (!res.ok) return [];
    return (((await res.json()) as { data?: Array<{ id: string }> }).data ?? []).map((m) => m.id);
  }

  async available(): Promise<boolean> {
    try {
      return (await this.listModels()).length > 0;
    } catch {
      return false;
    }
  }
}
