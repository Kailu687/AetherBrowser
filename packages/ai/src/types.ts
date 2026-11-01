export type Role = "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

/**
 * What kind of user content a request carries. Consent is granted per scope,
 * so a user can allow "selection" to go to a cloud model but never "page".
 */
export type DataScope =
  | "prompt" // text the user typed into the AI box
  | "selection" // highlighted text
  | "note" // notebook content
  | "page" // current page content
  | "pdf" // PDF text
  | "draft" // paper draft
  | "references"; // bibliography metadata

export const SCOPE_LABELS: Record<DataScope, string> = {
  prompt: "What you type to the assistant",
  selection: "Text you have selected",
  note: "Your notes",
  page: "Content of the current web page",
  pdf: "Text of the open PDF",
  draft: "Your paper draft",
  references: "Your reference list",
};

export interface CompletionRequest {
  /** Feature asking, shown in consent prompts and the audit log, e.g. "Summarise selection". */
  purpose: string;
  scopes: DataScope[];
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  model?: string;
  signal?: AbortSignal;
}

export interface CompletionResult {
  text: string;
  provider: string;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** Set when the provider declined to answer. */
  refused?: boolean;
}

export interface ProviderInfo {
  id: string;
  label: string;
  /** "local" only when the endpoint is a loopback address; verified, not just claimed. */
  kind: "local" | "cloud";
  /** Host that receives the data, shown to the user before consent. */
  host: string;
  defaultModel: string;
}

export interface AiProvider {
  readonly info: ProviderInfo;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** Yields text chunks; resolves to the final result. */
  stream?(req: CompletionRequest, onText: (chunk: string) => void): Promise<CompletionResult>;
  /** Cheap health check (e.g. list models). */
  available?(): Promise<boolean>;
  listModels?(): Promise<string[]>;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: "disabled" | "consent-required" | "network" | "auth" | "rate-limit" | "bad-request" | "refused" | "aborted" | "unavailable",
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export type FetchLike = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  body?: ReadableStream<Uint8Array> | null;
}>;

/** True for localhost, 127.0.0.0/8, ::1 — the only endpoints AETHER labels "local". */
export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

export function httpError(status: number, body: string, host: string): AiError {
  const brief = body.slice(0, 300);
  if (status === 401 || status === 403) return new AiError(`${host} rejected the API key (HTTP ${status}).`, "auth", brief);
  if (status === 429) return new AiError(`${host} is rate limiting requests; try again shortly.`, "rate-limit", brief);
  if (status >= 400 && status < 500) return new AiError(`${host} rejected the request (HTTP ${status}): ${brief}`, "bad-request", brief);
  return new AiError(`${host} returned HTTP ${status}.`, "network", brief);
}
