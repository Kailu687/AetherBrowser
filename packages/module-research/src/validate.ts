import type { Reference } from "@aether/citations";

/** Runtime validators for IPC payloads from the privileged UI. Everything is checked; nothing is trusted by shape. */
export class PayloadError extends Error {
  name = "PayloadError";
}

export type Obj = Record<string, unknown>;

export function obj(v: unknown, what = "payload"): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PayloadError(`${what} must be an object`);
  return v as Obj;
}

export function str(o: Obj, k: string, max = 100_000): string {
  const v = o[k];
  if (typeof v !== "string") throw new PayloadError(`${k} must be a string`);
  if (v.length > max) throw new PayloadError(`${k} is too long`);
  return v;
}

export function optStr(o: Obj, k: string, max = 100_000): string | undefined {
  return o[k] === undefined || o[k] === null || o[k] === "" ? undefined : str(o, k, max);
}

/** Names that would reach Object.prototype when used as record keys. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype", "hasOwnProperty", "toString", "valueOf"]);

export function id(o: Obj, k: string): string {
  const v = str(o, k, 200);
  if (!/^[\w:.\-+/]{1,200}$/.test(v) || v.includes("..") || FORBIDDEN_KEYS.has(v)) throw new PayloadError(`${k} is not a valid id`);
  return v;
}

export function optId(o: Obj, k: string): string | undefined {
  return o[k] === undefined || o[k] === null || o[k] === "" ? undefined : id(o, k);
}

export function strArray(o: Obj, k: string, maxItems = 1000, maxLen = 1000): string[] {
  const v = o[k];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > maxItems || !v.every((x) => typeof x === "string" && x.length <= maxLen)) throw new PayloadError(`${k} must be a list of strings`);
  return v as string[];
}

export function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[], fallback?: T): T {
  const v = o[k] ?? fallback;
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new PayloadError(`${k} must be one of ${allowed.join(", ")}`);
  return v as T;
}

export function optInt(o: Obj, k: string, min: number, max: number): number | undefined {
  const v = o[k];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new PayloadError(`${k} must be a whole number between ${min} and ${max}`);
  return v;
}

export const bool = (o: Obj, k: string): boolean | undefined => (typeof o[k] === "boolean" ? (o[k] as boolean) : undefined);

const REF_STRING_FIELDS = [
  "type", "title", "title-short", "container-title", "container-title-short", "collection-title", "event-title", "event-place",
  "volume", "issue", "page", "number-of-pages", "number", "edition", "publisher", "publisher-place", "genre", "archive",
  "archive_location", "medium", "version", "DOI", "URL", "ISBN", "ISSN", "PMID", "abstract", "keyword", "note", "language",
] as const;

const nameOk = (n: unknown) => {
  if (!n || typeof n !== "object" || Array.isArray(n)) return false;
  return Object.entries(n).every(([k, v]) => ["family", "given", "literal", "suffix", "non-dropping-particle", "dropping-particle"].includes(k) && typeof v === "string" && v.length <= 300);
};
const dateOk = (d: unknown) => {
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  const o = d as Obj;
  if (o["date-parts"] !== undefined && !(Array.isArray(o["date-parts"]) && o["date-parts"].length <= 2 && o["date-parts"].every((p) => Array.isArray(p) && p.length <= 3 && p.every((x) => typeof x === "number" || (typeof x === "string" && x.length <= 10))))) return false;
  return ["literal", "raw"].every((k) => o[k] === undefined || (typeof o[k] === "string" && (o[k] as string).length <= 100));
};

/** Copy only known CSL-JSON fields with the right types and sane sizes. */
export function reference(v: unknown, what = "reference"): Reference {
  const o = obj(v, what);
  const ref: Record<string, unknown> = { id: id(o, "id") };
  for (const k of REF_STRING_FIELDS) {
    const x = o[k];
    if (x === undefined || x === null) continue;
    if (typeof x === "number" && Number.isFinite(x)) ref[k] = x;
    else if (typeof x === "string") ref[k] = x.slice(0, k === "abstract" ? 20_000 : 2000);
  }
  if (typeof ref.type !== "string") ref.type = "article";
  for (const k of ["author", "editor"] as const) {
    const list = o[k];
    if (Array.isArray(list) && list.length <= 500 && list.every(nameOk)) ref[k] = list;
  }
  for (const k of ["issued", "accessed"] as const) if (dateOk(o[k])) ref[k] = o[k];
  return ref as unknown as Reference;
}

export function references(o: Obj, k: string, max = 5000): Reference[] {
  const v = o[k];
  if (!Array.isArray(v) || v.length > max) throw new PayloadError(`${k} must be a list of at most ${max} references`);
  return v.map((r, i) => reference(r, `${k}[${i}]`));
}
