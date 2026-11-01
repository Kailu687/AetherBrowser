import { createId, Emitter, systemClock, type Clock } from "@aether/research-core";
import { AiError, SCOPE_LABELS, type AiProvider, type CompletionRequest, type CompletionResult, type DataScope } from "./types.js";
import { redact, type RedactionRule } from "./redact.js";

export interface ConsentGrant {
  providerId: string;
  scopes: DataScope[];
  grantedAt: string;
  /** ISO time after which the grant lapses; undefined = until revoked. */
  expiresAt?: string;
}

/** Everything the UI must show before a user agrees to send data. */
export interface ConsentRequest {
  providerId: string;
  providerLabel: string;
  kind: "local" | "cloud";
  host: string;
  purpose: string;
  missingScopes: DataScope[];
  scopeLabels: string[];
  characters: number;
}

export interface AuditEntry {
  id: string;
  at: string;
  providerId: string;
  host: string;
  kind: "local" | "cloud";
  model: string;
  purpose: string;
  scopes: DataScope[];
  inputChars: number;
  outputChars: number;
  redactions: number;
  outcome: "ok" | "refused" | "error";
  error?: string;
}

export interface GatewaySettings {
  /** Master switch. AI is off until the user turns it on. */
  enabled: boolean;
  /** Ask before sending to local models too (default false: loopback data never leaves the device). */
  confirmLocal: boolean;
  /** Mask emails, phone numbers and credentials before sending to cloud providers. */
  redactCloud: boolean;
  activeProvider?: string;
}

export interface GatewayState {
  settings: GatewaySettings;
  grants: ConsentGrant[];
  audit: AuditEntry[];
}

/**
 * The only path from AETHER features to a model. It enforces the master
 * switch, per-provider per-scope consent, optional redaction, and records an
 * audit entry for every request (metadata only — prompt text is not stored).
 */
export class AiGateway {
  readonly events = new Emitter<{ type: "audit"; entry: AuditEntry } | { type: "consent-changed" } | { type: "settings-changed" }>();
  private readonly providers = new Map<string, AiProvider>();
  private state: GatewayState;

  constructor(
    initial?: Partial<GatewayState>,
    private readonly clock: Clock = systemClock,
    private readonly rules?: RedactionRule[],
    private readonly auditLimit = 1000,
  ) {
    this.state = {
      settings: { enabled: false, confirmLocal: false, redactCloud: true, ...initial?.settings },
      grants: initial?.grants ?? [],
      audit: initial?.audit ?? [],
    };
  }

  /** Serialisable state for the shell to persist in profile storage. */
  snapshot(): GatewayState {
    return structuredClone(this.state);
  }

  register(p: AiProvider): void {
    this.providers.set(p.info.id, p);
    this.state.settings.activeProvider ??= p.info.id;
  }

  unregister(id: string): void {
    this.providers.delete(id);
    if (this.state.settings.activeProvider === id) this.state.settings.activeProvider = [...this.providers.keys()][0];
  }

  getProvider(id: string): AiProvider | undefined {
    return this.providers.get(id);
  }

  listProviders() {
    return [...this.providers.values()].map((p) => p.info);
  }

  updateSettings(patch: Partial<GatewaySettings>): void {
    this.state.settings = { ...this.state.settings, ...patch };
    this.events.emit({ type: "settings-changed" });
  }

  get settings(): GatewaySettings {
    return { ...this.state.settings };
  }

  grant(providerId: string, scopes: DataScope[], opts: { ttlMs?: number } = {}): void {
    const now = this.clock.now();
    const existing = this.activeGrant(providerId);
    const merged = [...new Set([...(existing?.scopes ?? []), ...scopes])];
    this.state.grants = this.state.grants.filter((g) => g.providerId !== providerId);
    this.state.grants.push({
      providerId,
      scopes: merged,
      grantedAt: now.toISOString(),
      ...(opts.ttlMs ? { expiresAt: new Date(now.getTime() + opts.ttlMs).toISOString() } : {}),
    });
    this.events.emit({ type: "consent-changed" });
  }

  revoke(providerId: string, scopes?: DataScope[]): void {
    this.state.grants = this.state.grants
      .map((g) => (g.providerId !== providerId ? g : scopes ? { ...g, scopes: g.scopes.filter((s) => !scopes.includes(s)) } : null))
      .filter((g): g is ConsentGrant => !!g && g.scopes.length > 0);
    this.events.emit({ type: "consent-changed" });
  }

  private activeGrant(providerId: string): ConsentGrant | undefined {
    const now = this.clock.now().toISOString();
    return this.state.grants.find((g) => g.providerId === providerId && (!g.expiresAt || g.expiresAt > now));
  }

  /** Returns what consent is still needed for a request, or null if it may proceed. */
  consentNeeded(req: Pick<CompletionRequest, "purpose" | "scopes" | "messages" | "system">, providerId = this.state.settings.activeProvider): ConsentRequest | null {
    const p = providerId ? this.providers.get(providerId) : undefined;
    if (!p) throw new AiError("No AI provider is configured. Add one in Settings › AI.", "unavailable");
    if (p.info.kind === "local" && !this.state.settings.confirmLocal) return null;
    const have = this.activeGrant(p.info.id)?.scopes ?? [];
    const missing = req.scopes.filter((s) => !have.includes(s));
    if (!missing.length) return null;
    return {
      providerId: p.info.id,
      providerLabel: p.info.label,
      kind: p.info.kind,
      host: p.info.host,
      purpose: req.purpose,
      missingScopes: missing,
      scopeLabels: missing.map((s) => SCOPE_LABELS[s]),
      characters: (req.system?.length ?? 0) + req.messages.reduce((n, m) => n + m.content.length, 0),
    };
  }

  /**
   * Run a request. Throws AiError("disabled") when AI is off and
   * AiError("consent-required", ConsentRequest) when the user must approve first.
   */
  async run(req: CompletionRequest, opts: { providerId?: string; onText?: (s: string) => void } = {}): Promise<CompletionResult & { auditId: string }> {
    if (!this.state.settings.enabled) throw new AiError("AI features are turned off. Turn them on in Settings › AI.", "disabled");
    const providerId = opts.providerId ?? this.state.settings.activeProvider;
    const needed = this.consentNeeded(req, providerId);
    if (needed) throw new AiError(`${needed.providerLabel} needs your permission to receive: ${needed.scopeLabels.join(", ")}.`, "consent-required", needed);
    const p = this.providers.get(providerId!)!;

    let redactions = 0;
    let send = req;
    if (p.info.kind === "cloud" && this.state.settings.redactCloud) {
      const sys = req.system ? redact(req.system, this.rules) : undefined;
      const msgs = req.messages.map((m) => {
        const r = redact(m.content, this.rules);
        redactions += r.count;
        return { ...m, content: r.text };
      });
      redactions += sys?.count ?? 0;
      send = { ...req, messages: msgs, ...(sys ? { system: sys.text } : {}) };
    }

    const entry: AuditEntry = {
      id: createId("ai"),
      at: this.clock.now().toISOString(),
      providerId: p.info.id,
      host: p.info.host,
      kind: p.info.kind,
      model: send.model ?? p.info.defaultModel,
      purpose: req.purpose,
      scopes: req.scopes,
      inputChars: (send.system?.length ?? 0) + send.messages.reduce((n, m) => n + m.content.length, 0),
      outputChars: 0,
      redactions,
      outcome: "ok",
    };
    try {
      const result = opts.onText && p.stream ? await p.stream(send, opts.onText) : await p.complete(send);
      entry.model = result.model;
      entry.outputChars = result.text.length;
      if (result.refused) entry.outcome = "refused";
      return { ...result, auditId: entry.id };
    } catch (e) {
      entry.outcome = "error";
      entry.error = (e as Error).message;
      throw e;
    } finally {
      this.state.audit.push(entry);
      if (this.state.audit.length > this.auditLimit) this.state.audit.splice(0, this.state.audit.length - this.auditLimit);
      this.events.emit({ type: "audit", entry });
    }
  }

  auditLog(): AuditEntry[] {
    return [...this.state.audit].reverse();
  }

  clearAudit(): void {
    this.state.audit = [];
  }
}
