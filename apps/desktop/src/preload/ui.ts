/**
 * Preload for the privileged browser UI only. Web content gets no preload.
 * Exposes a frozen, allowlisted bridge: no raw ipcRenderer, no Node APIs.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, type AetherBridge, type EventChannel, type InvokeChannel } from '../shared/types';

const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

const bridge: AetherBridge = {
  invoke(channel: InvokeChannel, payload?: unknown) {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  on(channel: EventChannel, listener: (payload: any) => void) {
    if (!eventAllowed.has(channel)) throw new Error(`Blocked IPC event: ${channel}`);
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

contextBridge.exposeInMainWorld('aether', Object.freeze(bridge));
