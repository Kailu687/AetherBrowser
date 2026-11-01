/**
 * Tiny runtime validators for IPC payloads. Every privileged IPC handler
 * parses its payload through one of these so a compromised or buggy UI cannot
 * pass unexpected shapes into the main process.
 */

export class ValidationError extends Error {}

type Check<T> = (v: unknown, path: string) => T;

const fail = (path: string, expected: string): never => {
  throw new ValidationError(`Invalid IPC payload at ${path || 'root'}: expected ${expected}`);
};

export const v = {
  string:
    (max = 8192): Check<string> =>
    (x, p) =>
      typeof x === 'string' && x.length <= max ? x : fail(p, `string <= ${max}`),
  int:
    (min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): Check<number> =>
    (x, p) =>
      typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : fail(p, `integer in [${min}, ${max}]`),
  number:
    (min = -Infinity, max = Infinity): Check<number> =>
    (x, p) =>
      typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : fail(p, `number in [${min}, ${max}]`),
  bool: (): Check<boolean> => (x, p) => (typeof x === 'boolean' ? x : fail(p, 'boolean')),
  literal:
    <T extends string>(...values: T[]): Check<T> =>
    (x, p) =>
      typeof x === 'string' && (values as string[]).includes(x) ? (x as T) : fail(p, values.join(' | ')),
  optional:
    <T>(c: Check<T>): Check<T | undefined> =>
    (x, p) =>
      x === undefined ? undefined : c(x, p),
  nullable:
    <T>(c: Check<T>): Check<T | null> =>
    (x, p) =>
      x === null ? null : c(x, p),
  object:
    <S extends Record<string, Check<any>>>(shape: S): Check<{ [K in keyof S]: ReturnType<S[K]> }> =>
    (x, p) => {
      if (typeof x !== 'object' || x === null || Array.isArray(x)) return fail(p, 'object');
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) out[key] = shape[key]((x as Record<string, unknown>)[key], p ? `${p}.${key}` : key);
      return out as { [K in keyof S]: ReturnType<S[K]> };
    },
  array:
    <T>(c: Check<T>, max = 1000): Check<T[]> =>
    (x, p) => {
      if (!Array.isArray(x) || x.length > max) return fail(p, `array <= ${max}`);
      return x.map((item, i) => c(item, `${p}[${i}]`));
    },
  any: (): Check<unknown> => (x) => x,
};

export function parse<T>(check: Check<T>, payload: unknown): T {
  return check(payload, '');
}

export const tabId = v.int(0);
export const rect = v.object({ x: v.number(0, 100_000), y: v.number(0, 100_000), width: v.number(0, 100_000), height: v.number(0, 100_000) });
export const color = (x: unknown, p: string) => (typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x) ? x : fail(p, '#rrggbb color'));
