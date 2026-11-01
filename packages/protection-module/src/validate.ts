/** Minimal payload validation for IPC calls; the renderer is trusted less than main. */
export class InvalidPayloadError extends Error {}

export function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new InvalidPayloadError('Expected an object');
  return v as Record<string, unknown>;
}

export function str(v: unknown, max = 4096): string {
  if (typeof v !== 'string' || v.length > max) throw new InvalidPayloadError('Expected a string');
  return v;
}

export function num(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new InvalidPayloadError('Expected a number');
  return v;
}

export function optNum(v: unknown, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = num(v);
  if (n < min || n > max) throw new InvalidPayloadError(`Expected a number between ${min} and ${max}`);
  return n;
}

export function bool(v: unknown): boolean {
  if (typeof v !== 'boolean') throw new InvalidPayloadError('Expected a boolean');
  return v;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) throw new InvalidPayloadError(`Expected one of ${allowed.join(', ')}`);
  return v as T;
}
