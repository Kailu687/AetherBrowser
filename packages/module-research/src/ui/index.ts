import { createElement, lazy, Suspense, type ComponentType } from "react";
import type { AetherRendererModule, WorkbenchAppApi } from "@aether/plugin-api";
import { manifest } from "../manifest.js";

type AppComponent = ComponentType<{ api: WorkbenchAppApi }>;

/** Each app's code loads the first time it is opened. */
function lazyApp(load: () => Promise<AppComponent>): AppComponent {
  const L = lazy(async () => ({ default: await load() }));
  return function ResearchModuleApp(props: { api: WorkbenchAppApi }) {
    return createElement(Suspense, { fallback: createElement("div", { className: "wb-loading" }, "Loading…") }, createElement(L, props));
  };
}

const info = (id: string) => manifest.apps.find((a) => a.id === id)!;

export const rendererModule: AetherRendererModule = {
  id: manifest.id,
  apps: [
    { ...info("research.review"), addon: manifest.id, component: lazyApp(async () => (await import("./ReviewApp.js")).ReviewApp) },
    { ...info("research.verify"), addon: manifest.id, component: lazyApp(async () => (await import("./VerifyApp.js")).VerifyApp) },
    { ...info("research.library"), addon: manifest.id, component: lazyApp(async () => (await import("./LibraryApp.js")).LibraryApp) },
    { ...info("research.trail"), addon: manifest.id, component: lazyApp(async () => (await import("./TrailApp.js")).TrailApp) },
  ],
};
