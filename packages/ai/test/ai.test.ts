import { describe, it, expect } from "vitest";
import { AiGateway, AiError, OllamaProvider, OpenAICompatibleProvider, AnthropicProvider, redact, isLoopback, summarizeTask, reviseTask, parseClaimCheck, type FetchLike, type AnthropicClientLike, type ConsentRequest } from "@aether/ai";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

function fakeFetch(handler: (url: string, body: any) => { status?: number; json?: unknown; chunks?: string[] }): FetchLike & { calls: Array<{ url: string; body: any; headers?: Record<string, string> }> } {
  const calls: Array<{ url: string; body: any; headers?: Record<string, string> }> = [];
  const f = (async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, headers: init.headers });
    const r = handler(url, body);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.json, text: async () => JSON.stringify(r.json ?? ""), body: r.chunks ? streamOf(r.chunks) : null };
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const clock = () => {
  let t = Date.UTC(2026, 9, 29, 12);
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
};

describe("providers", () => {
  it("labels only loopback endpoints as local", () => {
    expect(isLoopback("http://127.0.0.1:11434")).toBe(true);
    expect(isLoopback("http://localhost:1234/v1")).toBe(true);
    expect(isLoopback("http://[::1]:8080")).toBe(true);
    expect(isLoopback("http://192.168.1.5:11434")).toBe(false);
    expect(isLoopback("https://localhost.evil.com")).toBe(false);
    expect(new OllamaProvider({ baseUrl: "http://10.0.0.2:11434" }).info.kind).toBe("cloud");
  });

  it("Ollama completes and streams NDJSON split across chunks", async () => {
    const f = fakeFetch((url, body) =>
      body?.stream
        ? { chunks: ['{"message":{"content":"Hel"}}\n{"mess', 'age":{"content":"lo"}}\n{"done":true,"prompt_eval_count":5,"eval_count":2}\n'] }
        : { json: { message: { content: "Hi" }, model: "llama3.2", eval_count: 1 } },
    );
    const p = new OllamaProvider({ fetch: f });
    const r = await p.complete({ purpose: "t", scopes: ["prompt"], system: "sys", messages: [{ role: "user", content: "x" }] });
    expect(r.text).toBe("Hi");
    expect(f.calls[0]!.body.messages[0]).toEqual({ role: "system", content: "sys" });
    const seen: string[] = [];
    const s = await p.stream({ purpose: "t", scopes: ["prompt"], messages: [{ role: "user", content: "x" }] }, (c) => seen.push(c));
    expect(seen).toEqual(["Hel", "lo"]);
    expect(s).toMatchObject({ text: "Hello", usage: { inputTokens: 5, outputTokens: 2 } });
  });

  it("Ollama reports when it is not running", async () => {
    const p = new OllamaProvider({ fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as FetchLike });
    await expect(p.complete({ purpose: "t", scopes: [], messages: [] })).rejects.toMatchObject({ kind: "unavailable" });
    expect(await p.available()).toBe(false);
  });

  it("OpenAI-compatible streams SSE and maps HTTP errors", async () => {
    const f = fakeFetch((_u, body) =>
      body.stream ? { chunks: ['data: {"choices":[{"delta":{"content":"A"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"B"}}]}\n\ndata: [DONE]\n\n'] } : { status: 401, json: { error: "bad key" } },
    );
    const p = new OpenAICompatibleProvider({ baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m" });
    expect(p.info).toMatchObject({ kind: "cloud", host: "api.example.com" });
    const lp = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:1234/v1", model: "qwen", fetch: f });
    expect(lp.info.kind).toBe("local");
    const out: string[] = [];
    expect((await lp.stream({ purpose: "t", scopes: [], messages: [{ role: "user", content: "x" }] }, (c) => out.push(c))).text).toBe("AB");
    await expect(lp.complete({ purpose: "t", scopes: [], messages: [] })).rejects.toMatchObject({ kind: "auth" });
  });

  it("Anthropic provider streams via the SDK with refusal fallback", async () => {
    let params: Record<string, unknown> = {};
    const client: AnthropicClientLike = {
      beta: {
        messages: {
          stream(p) {
            params = p;
            const events = [
              { type: "content_block_delta", delta: { type: "text_delta", text: "Hi " } },
              { type: "content_block_delta", delta: { type: "text_delta", text: "there" } },
            ];
            return Object.assign(
              (async function* () {
                yield* events;
              })(),
              { finalMessage: async () => ({ content: [{ type: "text", text: "Hi there" }], model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }) },
            );
          },
        },
      },
    };
    const p = new AnthropicProvider({ apiKey: "sk-test", createClient: async () => client });
    const chunks: string[] = [];
    const r = await p.stream({ purpose: "t", scopes: ["prompt"], system: "S", messages: [{ role: "user", content: "hello" }] }, (c) => chunks.push(c));
    expect(chunks.join("")).toBe("Hi there");
    expect(r).toMatchObject({ text: "Hi there", model: "claude-opus-5-5", usage: { inputTokens: 3, outputTokens: 2 } });
    expect(params).toMatchObject({ model: "claude-opus-5-5", system: "S", betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", max_tokens: 16000 });
    const failing = new AnthropicProvider({ apiKey: "x", createClient: async () => ({ beta: { messages: { stream: () => { throw Object.assign(new Error("nope"), { status: 429 }); } } } }) as never });
    await expect(failing.complete({ purpose: "t", scopes: [], messages: [] })).rejects.toMatchObject({ kind: "rate-limit" });
  });
});

describe("AiGateway", () => {
  const cloud = () => {
    const f = fakeFetch((_u, body) => ({ json: { choices: [{ message: { content: `echo:${body.messages.at(-1).content}` } }], model: "m" } }));
    return { f, p: new OpenAICompatibleProvider({ id: "cloudy", baseUrl: "https://api.example.com/v1", model: "m", fetch: f }) };
  };

  it("is off by default and requires per-scope consent for cloud providers", async () => {
    const c = clock();
    const gw = new AiGateway({}, c);
    const { p, f } = cloud();
    gw.register(p);
    const req = summarizeTask("The LNA has 1.2 dB NF.", "selection");
    await expect(gw.run(req)).rejects.toMatchObject({ kind: "disabled" });
    gw.updateSettings({ enabled: true });
    const err = (await gw.run(req).catch((e) => e)) as AiError;
    expect(err.kind).toBe("consent-required");
    expect(err.detail as ConsentRequest).toMatchObject({ providerId: "cloudy", host: "api.example.com", missingScopes: ["selection"], scopeLabels: ["Text you have selected"] });
    expect(f.calls).toHaveLength(0);
    gw.grant("cloudy", ["selection"], { ttlMs: 60_000 });
    expect((await gw.run(req)).text).toContain("echo:");
    // Consent is scope-specific and expires.
    await expect(gw.run(reviseTask("x", "grammar"))).rejects.toMatchObject({ kind: "consent-required" });
    c.advance(61_000);
    await expect(gw.run(req)).rejects.toMatchObject({ kind: "consent-required" });
  });

  it("local providers skip prompts unless confirmLocal is on", async () => {
    const f = fakeFetch(() => ({ json: { message: { content: "ok" } } }));
    const gw = new AiGateway({ settings: { enabled: true, confirmLocal: false, redactCloud: true } });
    gw.register(new OllamaProvider({ fetch: f }));
    expect((await gw.run(summarizeTask("t", "page"))).text).toBe("ok");
    gw.updateSettings({ confirmLocal: true });
    await expect(gw.run(summarizeTask("t", "page"))).rejects.toMatchObject({ kind: "consent-required" });
  });

  it("redacts for cloud, audits metadata only, and revokes", async () => {
    const gw = new AiGateway({ settings: { enabled: true, confirmLocal: false, redactCloud: true } });
    const { p, f } = cloud();
    gw.register(p);
    gw.grant("cloudy", ["draft"]);
    const r = await gw.run(reviseTask("Mail kailash@example.com or call +91 98765 43210, key sk-ant-abcdefghijklmnopqrstu", "grammar"));
    expect(f.calls[0]!.body.messages[1].content).toBe("Mail [email] or call [phone], key [credential]");
    const [entry] = gw.auditLog();
    expect(entry).toMatchObject({ id: r.auditId, providerId: "cloudy", kind: "cloud", purpose: "Revise text (grammar)", scopes: ["draft"], redactions: 3, outcome: "ok" });
    expect(JSON.stringify(gw.snapshot().audit)).not.toContain("Mail");
    gw.revoke("cloudy", ["draft"]);
    expect(gw.snapshot().grants).toEqual([]);
  });

  it("records failures", async () => {
    const gw = new AiGateway({ settings: { enabled: true, confirmLocal: false, redactCloud: false } });
    gw.register(new OllamaProvider({ fetch: (async () => ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) })) as unknown as FetchLike }));
    await expect(gw.run(summarizeTask("t", "note"))).rejects.toBeInstanceOf(AiError);
    expect(gw.auditLog()[0]).toMatchObject({ outcome: "error" });
    const empty = new AiGateway({ settings: { enabled: true, confirmLocal: false, redactCloud: false } });
    await expect(empty.run(summarizeTask("t", "note"))).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("helpers", () => {
  it("redaction leaves technical numbers alone", () => {
    expect(redact("Vout = 3.3 V at 100 kHz, R = 4700, part LM741CN").count).toBe(0);
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----").text).toBe("[private key]");
  });
  it("parses claim checks defensively", () => {
    expect(parseClaimCheck('Here: [{"quote":"GaN is faster","reason":"comparison"}]')).toEqual([{ quote: "GaN is faster", reason: "comparison" }]);
    expect(parseClaimCheck("no json")).toEqual([]);
    expect(parseClaimCheck("[{bad")).toEqual([]);
  });
});
