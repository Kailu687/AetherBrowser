export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/** Conservative defaults: obvious secrets and contact details. Not a guarantee of anonymity. */
export const DEFAULT_RULES: RedactionRule[] = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[private key]" },
  { name: "api-key", pattern: /\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: "[credential]" },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g, replacement: "Bearer [credential]" },
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, replacement: "[email]" },
  { name: "phone", pattern: /(?<![\w.])(?:\+\d{1,3}[\s-]?\d(?:[\s-]?\d){7,12}|\(?\d{3}\)?[\s-]\d{3}[\s-]\d{4})(?![\w.])/g, replacement: "[phone]" },
  { name: "card", pattern: /\b(?:\d[ -]?){13,19}\b/g, replacement: "[number]" },
];

export function redact(text: string, rules: RedactionRule[] = DEFAULT_RULES): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const r of rules) {
    out = out.replace(r.pattern, () => {
      count++;
      return r.replacement;
    });
  }
  return { text: out, count };
}
