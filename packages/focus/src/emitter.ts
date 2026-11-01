export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<(payload: any) => void>>();

  on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set!.delete(listener);
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const l of this.listeners.get(event) ?? []) {
      try {
        l(payload);
      } catch {
        // A faulty listener must not break the timer or request handling.
      }
    }
  }
}
