import type { AetherBridge, InvokeChannel } from '../shared/types';

declare global {
  interface Window {
    aether: AetherBridge;
  }
}

export const bridge: AetherBridge = window.aether;

export function call<T = unknown>(channel: InvokeChannel, payload?: unknown): Promise<T> {
  return bridge.invoke<T>(channel, payload).catch((err: unknown) => {
    console.error(`[ui] ${channel} failed`, err);
    throw err;
  });
}

/** Fire-and-forget call that never surfaces as an unhandled rejection. */
export function send(channel: InvokeChannel, payload?: unknown): void {
  void bridge.invoke(channel, payload).catch((err: unknown) => console.error(`[ui] ${channel} failed`, err));
}
