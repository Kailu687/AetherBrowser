/**
 * Sensitive-data detection for datasets and prompts.
 *
 * Pattern matching with checksums where a standard defines one (Luhn for card
 * numbers, Verhoeff for Aadhaar), so random 12- or 16-digit numbers are not
 * flagged. It is a warning aid, not a guarantee: it misses names, addresses
 * and anything written in an unexpected format.
 */

export type PiiKind = 'email' | 'phone' | 'card' | 'aadhaar' | 'pan' | 'ssn' | 'iban' | 'ip' | 'api-key' | 'private-key' | 'password-field';

export interface PiiFinding {
  kind: PiiKind;
  /** Masked example, never the full value. */
  sample: string;
  count: number;
}

export const PII_LABELS: Record<PiiKind, string> = {
  email: 'Email addresses',
  phone: 'Phone numbers',
  card: 'Payment card numbers (Luhn-valid)',
  aadhaar: 'Aadhaar numbers (Verhoeff-valid)',
  pan: 'PAN numbers',
  ssn: 'US Social Security numbers',
  iban: 'IBANs',
  ip: 'IP addresses',
  'api-key': 'API keys or tokens',
  'private-key': 'Private keys',
  'password-field': 'Password-like fields',
};

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeffValid(digits: string): boolean {
  let c = 0;
  const rev = digits.split('').reverse();
  for (let i = 0; i < rev.length; i++) {
    const d = rev[i].charCodeAt(0) - 48;
    if (d < 0 || d > 9) return false;
    c = VD[c][VP[i % 8][d]];
  }
  return c === 0;
}

function ibanValid(s: string): boolean {
  const v = s.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  const r = v.slice(4) + v.slice(0, 4);
  let rem = 0;
  for (const ch of r) {
    const code = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of code) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

export function mask(s: string): string {
  const t = s.trim();
  if (t.length <= 4) return '•'.repeat(t.length);
  return t.slice(0, 2) + '•'.repeat(Math.min(12, t.length - 4)) + t.slice(-2);
}

interface Rule {
  kind: PiiKind;
  re: RegExp;
  check?: (m: string) => boolean;
}

const RULES: Rule[] = [
  { kind: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'api-key', re: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|AIza[0-9A-Za-z_-]{35}|xox[abprs]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20})\b/g },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g },
  { kind: 'card', re: /\b(?:\d[ -]?){13,19}\b/g, check: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhnValid(d) && !/^(\d)\1+$/.test(d); } },
  { kind: 'aadhaar', re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g, check: (m) => verhoeffValid(m.replace(/\D/g, '')) },
  { kind: 'pan', re: /\b[A-Z]{3}[PCHABGJLFT][A-Z]\d{4}[A-Z]\b/g },
  { kind: 'ssn', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, check: ibanValid },
  { kind: 'phone', re: /(?:\+91[ -]?)?\b[6-9]\d{4}[ -]?\d{5}\b|\+\d{1,3}[ -]?\(?\d{1,4}\)?(?:[ -]?\d{2,4}){2,4}\b/g },
  { kind: 'ip', re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, check: (m) => !/^(?:0\.|127\.|255\.)/.test(m) && m.split('.').length === 4 },
];

const MAX_SCAN_CHARS = 2_000_000;

/** Scans free text (a prompt, a cell) and returns findings with masked samples. */
export function scanText(text: string): PiiFinding[] {
  const s = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const found = new Map<PiiKind, PiiFinding>();
  const taken: Array<[number, number]> = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(s))) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      if (rule.check && !rule.check(m[0])) continue;
      taken.push([start, end]);
      const f = found.get(rule.kind);
      if (f) f.count++;
      else found.set(rule.kind, { kind: rule.kind, sample: mask(m[0]), count: 1 });
    }
  }
  return [...found.values()];
}

const NAME_HINTS: Array<[RegExp, PiiKind]> = [
  [/pass(word|wd)?$|^pwd$|secret|api[_-]?key|token/i, 'password-field'],
  [/e-?mail/i, 'email'],
  [/phone|mobile|contact[_ ]?no/i, 'phone'],
  [/aadha?ar|uid[_ ]?no/i, 'aadhaar'],
  [/^pan([_ ]?(no|number|card))?$/i, 'pan'],
  [/card[_ ]?(no|number)|credit[_ ]?card|ccn/i, 'card'],
  [/^ssn$|social[_ ]?security/i, 'ssn'],
  [/^ip([_ ]?addr(ess)?)?$/i, 'ip'],
];

/** Flags a column by its name and a sample of its values. */
export function scanColumn(name: string, values: Array<string | number | boolean | null>, sample = 2000): PiiFinding[] {
  const out = new Map<PiiKind, PiiFinding>();
  for (const [re, kind] of NAME_HINTS) if (re.test(name)) out.set(kind, { kind, sample: `column name “${name}”`, count: 0 });
  const step = Math.max(1, Math.floor(values.length / sample));
  for (let i = 0; i < values.length; i += step) {
    const v = values[i];
    if (v === null || typeof v === 'boolean') continue;
    for (const f of scanText(String(v))) {
      const prev = out.get(f.kind);
      if (prev) {
        prev.count += f.count;
        if (prev.sample.startsWith('column name')) prev.sample = f.sample;
      } else out.set(f.kind, { ...f });
    }
  }
  return [...out.values()];
}

/** Replaces detected values with [KIND] placeholders (for prompts sent to cloud models). */
export function redactText(text: string): { text: string; findings: PiiFinding[] } {
  const findings = scanText(text);
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, (m) => (rule.check && !rule.check(m) ? m : `[${rule.kind.toUpperCase()}]`));
  }
  return { text: out, findings };
}
