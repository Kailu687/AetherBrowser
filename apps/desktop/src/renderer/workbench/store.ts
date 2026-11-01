import { useSyncExternalStore } from 'react';
import { bridge, call } from '../api';

/** Workbench state for this window: which apps are open and whether they cover the page or sit beside it. */
export interface WorkbenchState {
  visible: boolean;
  mode: 'full' | 'split';
  /** Fraction of the width given to the web page in split mode. */
  ratio: number;
  active: string | null;
  opened: { id: string; arg?: string; nonce: number }[];
}

const KEY = 'aether.workbench';
let state: WorkbenchState = load();
const subs = new Set<() => void>();

function load(): WorkbenchState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as WorkbenchState | null;
    if (s && Array.isArray(s.opened)) return { ...s, visible: false, ratio: s.ratio || 0.45 };
  } catch {
    /* ignore */
  }
  return { visible: false, mode: 'full', ratio: 0.45, active: null, opened: [] };
}

function set(next: Partial<WorkbenchState>) {
  state = { ...state, ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
  subs.forEach((f) => f());
}

export const workbench = {
  get: () => state,
  open(id: string, arg?: string) {
    const existing = state.opened.find((o) => o.id === id);
    const opened = existing ? state.opened.map((o) => (o.id === id && arg !== undefined ? { ...o, arg, nonce: Date.now() } : o)) : [...state.opened, { id, arg, nonce: Date.now() }];
    set({ visible: true, active: id, opened });
  },
  closeApp(id: string) {
    const opened = state.opened.filter((o) => o.id !== id);
    set({ opened, active: state.active === id ? (opened[opened.length - 1]?.id ?? null) : state.active, visible: opened.length > 0 && state.visible });
  },
  show: (visible: boolean) => set({ visible: visible && (state.opened.length > 0 || true) }),
  toggle: () => set({ visible: !state.visible }),
  setMode: (mode: WorkbenchState['mode']) => set({ mode }),
  setRatio: (ratio: number) => set({ ratio: Math.max(0.2, Math.min(0.8, ratio)) }),
  activate: (id: string) => set({ active: id, visible: true }),
};

export function useWorkbench(): WorkbenchState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}

// ---------------------------------------------------------------------------- installed modules

type Risk = 'low' | 'medium' | 'high';
export interface ModuleStatusRow {
  id: string;
  installed: { id: string; version: string; installedAt: number; permissions: string[]; digest: string; enabled: boolean } | null;
  compatible: boolean;
  osSupported: boolean;
  active: boolean;
  needsReview: boolean;
  missingDeps: string[];
}
export interface ModulesState {
  catalog: import('@aether/plugin-api').ModuleManifest[];
  status: ModuleStatusRow[];
  installed: NonNullable<ModuleStatusRow['installed']>[];
  studioConsent: string[];
  permissions: Record<string, { label: string; risk: Risk; detail: string }>;
  appVersion: string;
  safeMode: boolean;
  platform: string;
}
/** @deprecated */
export type AddonsState = ModulesState;

let modules: ModulesState | null = null;
const moduleSubs = new Set<() => void>();
let loading = false;

export function refreshAddons(): Promise<void> {
  loading = true;
  return call<ModulesState>('module:invoke', { moduleId: 'aether.modules', method: 'state' })
    .then((s) => {
      modules = s;
      moduleSubs.forEach((f) => f());
    })
    .catch(() => undefined)
    .finally(() => (loading = false));
}

bridge.on('module-event', (e: { event: string }) => {
  if (e.event === 'aether.modules:changed') void refreshAddons();
});
bridge.on('state', () => {
  // Profile switches change which modules are installed.
  if (modules) void refreshAddons();
});

export function useAddons(): ModulesState | null {
  return useSyncExternalStore(
    (f) => {
      moduleSubs.add(f);
      if (!modules && !loading) void refreshAddons();
      return () => moduleSubs.delete(f);
    },
    () => modules,
  );
}
export const useModules = useAddons;

/** True for built-in apps (no id) and for modules that are installed, enabled and not in safe mode. */
export function addonInstalled(s: ModulesState | null, id?: string): boolean {
  return !id || !!s?.status.some((p) => p.id === id && p.active);
}
export const moduleActive = addonInstalled;
