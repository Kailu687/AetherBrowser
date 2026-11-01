/** Tiny runtime validators for IPC payloads coming from the renderer. */
export class PayloadError extends Error {
  name = "PayloadError";
}

export type Obj = Record<string, unknown>;

export function obj(v: unknown, what = "payload"): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new PayloadError(`${what} must be an object`);
  return v as Obj;
}
export function str(o: Obj, k: string, optsOrMax: { optional?: boolean; max?: number } | number = {}): string {
  const opts = typeof optsOrMax === "number" ? { max: optsOrMax } : optsOrMax;
  const v = o[k];
  if (v === undefined || v === null) {
    if (opts.optional) return undefined as unknown as string;
    throw new PayloadError(`${k} is required`);
  }
  if (typeof v !== "string") throw new PayloadError(`${k} must be a string`);
  if (v.length > (opts.max ?? 2_000_000)) throw new PayloadError(`${k} is too long`);
  return v;
}
export const optStr = (o: Obj, k: string, max?: number): string | undefined => str(o, k, { optional: true, max });
export function strArray(o: Obj, k: string, max = 1000): string[] {
  const v = o[k];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === "string")) throw new PayloadError(`${k} must be a list of strings`);
  return v as string[];
}
export function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[], fallback?: T): T {
  const v = o[k] ?? fallback;
  if (typeof v !== "string" || !allowed.includes(v as T)) throw new PayloadError(`${k} must be one of ${allowed.join(", ")}`);
  return v as T;
}
export function int(o: Obj, k: string, opts: { optional?: boolean; min?: number; max?: number } = {}): number {
  const v = o[k];
  if (v === undefined && opts.optional) return undefined as unknown as number;
  if (typeof v !== "number" || !Number.isInteger(v) || v < (opts.min ?? -Infinity) || v > (opts.max ?? Infinity)) throw new PayloadError(`${k} must be an integer`);
  return v;
}
