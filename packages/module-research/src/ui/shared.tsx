import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import type { Reference } from "@aether/citations";
import "./research.css";

/** The shared citation library lives in the core research module. */
export const CORE_RESEARCH = "research";

export interface LibraryItem {
  id: string;
  ref: Reference;
  tags: string[];
}

export const library = {
  list: (api: WorkbenchAppApi) => api.invokeModule<LibraryItem[]>(CORE_RESEARCH, "library.list", {}),
  add: (api: WorkbenchAppApi, ref: Reference) => api.invokeModule<LibraryItem>(CORE_RESEARCH, "library.add", { ref, workspaceId: api.activeTab.workspaceId ?? undefined }),
  update: (api: WorkbenchAppApi, item: LibraryItem, ref: Reference) => api.invokeModule<LibraryItem>(CORE_RESEARCH, "library.update", { id: item.id, ref, tags: item.tags }),
};

export function refLabel(r: Reference | undefined, id = ""): string {
  if (!r) return id;
  const a = r.author?.[0];
  const who = a ? (a.family ?? a.literal ?? "") + ((r.author?.length ?? 0) > 1 ? " et al." : "") : "";
  const y = r.issued?.["date-parts"]?.[0]?.[0];
  return [who, y ? `(${y})` : ""].filter(Boolean).join(" ") || r.title || id;
}

export type Flash = { kind: "info" | "error"; text: string } | undefined;

/** Run an action with busy state and a message line. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>();
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: (v: T) => string | void): Promise<T | undefined> => {
    setBusy(true);
    setFlash(undefined);
    try {
      const v = await fn();
      const text = ok?.(v);
      if (text) setFlash({ kind: "info", text });
      return v;
    } catch (e) {
      setFlash({ kind: "error", text: cleanError(e) });
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, flash, setFlash, run };
}

export function cleanError(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (/module-not-installed/.test(m)) return "The Research & Writing module is not installed or is disabled for this profile.";
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export function FlashLine({ flash }: { flash: Flash }) {
  if (!flash) return null;
  return (
    <p className={`rsx-flash ${flash.kind}`} role={flash.kind === "error" ? "alert" : "status"}>
      {flash.text}
    </p>
  );
}

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): [T | undefined, () => void, string | undefined] {
  const [v, setV] = useState<T>();
  const [err, setErr] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (x) => live && (setV(x), setErr(undefined)),
      (e) => live && setErr(cleanError(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return [v, () => setTick((t) => t + 1), err];
}

/** Opens only http(s) links, in a new browser tab. */
export function ExtLink({ api, href, children }: { api: WorkbenchAppApi; href?: string; children: ReactNode }) {
  if (!href || !/^https?:\/\//i.test(href)) return <>{children}</>;
  return (
    <button type="button" className="wb-link" onClick={() => api.openUrl(href)}>
      {children}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rsx-empty">{children}</div>;
}

export function OnlineBadge() {
  return <span className="pill online">online</span>;
}
