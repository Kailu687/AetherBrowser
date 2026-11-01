/**
 * Shared primitives for AETHER research modules.
 *
 * The browser shell owns real persistence (SQLite, per-profile partitions).
 * Research modules only depend on the narrow `Collection` interface below so
 * the shell can supply a SQLite-backed implementation and tests can use
 * `MemoryCollection`.
 */

export type Id = string;

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Random, URL-safe id. Uses Web Crypto when available. */
export function createId(prefix = ""): Id {
  const bytes = new Uint8Array(12);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const body = Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
  return prefix ? `${prefix}_${body}` : body;
}

export interface Entity {
  id: Id;
  createdAt: string;
  updatedAt: string;
}

/**
 * A profile-scoped collection of JSON-serialisable records. Implementations
 * must keep data inside the active browser profile's storage.
 */
export interface Collection<T extends Entity> {
  get(id: Id): Promise<T | undefined>;
  list(filter?: (item: T) => boolean): Promise<T[]>;
  put(item: T): Promise<void>;
  delete(id: Id): Promise<boolean>;
}

export class MemoryCollection<T extends Entity> implements Collection<T> {
  private readonly items = new Map<Id, T>();

  async get(id: Id): Promise<T | undefined> {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }

  async list(filter?: (item: T) => boolean): Promise<T[]> {
    const all = [...this.items.values()].map((i) => structuredClone(i));
    return filter ? all.filter(filter) : all;
  }

  async put(item: T): Promise<void> {
    this.items.set(item.id, structuredClone(item));
  }

  async delete(id: Id): Promise<boolean> {
    return this.items.delete(id);
  }
}

export type Listener<E> = (event: E) => void;

/** Minimal typed event emitter used by stores and the consent manager. */
export class Emitter<E> {
  private listeners = new Set<Listener<E>>();
  on(listener: Listener<E>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: E): void {
    for (const l of this.listeners) l(event);
  }
}

/** Result type for operations that can fail in expected ways (network, parsing). */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function stamp<T extends object>(item: T, clock: Clock = systemClock, existing?: Entity): T & Entity {
  const now = clock.now().toISOString();
  return {
    ...item,
    id: existing?.id ?? createId(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  } as T & Entity;
}
