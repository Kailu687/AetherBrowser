import { AiError, type AiProvider, type CompletionRequest, type CompletionResult, type ProviderInfo } from "../types.js";

/** Minimal surface of the official SDK client that we use; lets tests inject a fake. */
export interface AnthropicClientLike {
  beta: {
    messages: {
      stream(params: Record<string, unknown>, opts?: { signal?: AbortSignal }): AsyncIterable<Record<string, any>> & {
        finalMessage(): Promise<{ content: Array<{ type: string; text?: string }>; model: string; stop_reason: string | null; usage?: { input_tokens?: number; output_tokens?: number } }>;
      };
    };
  };
}

export interface AnthropicOptions {
  apiKey: string;
  /** Defaults to Claude Opus 5.5. */
  model?: string;
  /** Retry declined requests on a fallback model server-side (default on). */
  refusalFallback?: boolean;
  /** Injected for tests; by default the official SDK is imported lazily on first use. */
  createClient?: (apiKey: string) => Promise<AnthropicClientLike>;
}

const defaultCreate = async (apiKey: string): Promise<AnthropicClientLike> => {
  let mod: { default: new (o: { apiKey: string; dangerouslyAllowBrowser?: boolean }) => unknown };
  try {
    mod = (await import("@anthropic-ai/sdk")) as never;
  } catch {
    throw new AiError("The Anthropic SDK is not installed. Run npm install @anthropic-ai/sdk.", "unavailable");
  }
  return new mod.default({ apiKey }) as AnthropicClientLike;
};

/**
 * Claude via the official Anthropic SDK. Runs in the Electron main process so
 * the key never reaches web content. Always streams to avoid HTTP timeouts.
 */
export class AnthropicProvider implements AiProvider {
  readonly info: ProviderInfo;
  private client?: Promise<AnthropicClientLike>;

  constructor(private readonly opts: AnthropicOptions) {
    this.info = { id: "anthropic", label: "Anthropic Claude", kind: "cloud", host: "api.anthropic.com", defaultModel: opts.model ?? "claude-opus-5-5" };
  }

  private getClient() {
    this.client ??= (this.opts.createClient ?? defaultCreate)(this.opts.apiKey);
    return this.client;
  }

  complete(req: CompletionRequest): Promise<CompletionResult> {
    return this.stream(req, () => undefined);
  }

  async stream(req: CompletionRequest, onText: (s: string) => void): Promise<CompletionResult> {
    const client = await this.getClient();
    const params: Record<string, unknown> = {
      model: req.model ?? this.info.defaultModel,
      max_tokens: req.maxTokens ?? 16000,
      messages: req.messages,
      ...(req.system ? { system: req.system } : {}),
    };
    if (this.opts.refusalFallback !== false) {
      params.betas = ["server-side-fallback-2026-07-01"];
      params.fallbacks = "default";
    }
    try {
      const s = client.beta.messages.stream(params, { signal: req.signal });
      for await (const ev of s) {
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") onText(ev.delta.text as string);
      }
      const msg = await s.finalMessage();
      const text = msg.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      return {
        text,
        provider: this.info.id,
        model: msg.model,
        usage: { inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens },
        ...(msg.stop_reason === "refusal" ? { refused: true } : {}),
      };
    } catch (e) {
      throw mapSdkError(e);
    }
  }
}

function mapSdkError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  const err = e as { status?: number; name?: string; message?: string };
  if (err.name === "AbortError" || err.name === "APIUserAbortError") return new AiError("Request cancelled.", "aborted");
  if (err.status === 401 || err.status === 403) return new AiError("Anthropic rejected the API key.", "auth");
  if (err.status === 429) return new AiError("Anthropic is rate limiting requests; try again shortly.", "rate-limit");
  if (err.status && err.status >= 400 && err.status < 500) return new AiError(`Anthropic rejected the request: ${err.message ?? ""}`, "bad-request");
  return new AiError(`Couldn't complete the request to Anthropic: ${err.message ?? String(e)}`, "network", e);
}
