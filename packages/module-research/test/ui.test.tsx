// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import type { WorkbenchAppApi } from "@aether/plugin-api";
import { createMainModule, manifest } from "../src/index.js";
import { rendererModule } from "../src/ui/index.js";
import { fakeHost, ABSTRACT } from "./helpers.js";

afterEach(cleanup);

/** A Workbench API backed by the real main module on an in-memory host, plus a fake core library. */
async function harness() {
  const h = fakeHost();
  const mod = createMainModule();
  await mod.activate(h.host);
  const lib = [{ id: "kumar2022", ref: { id: "kumar2022", type: "article-journal", title: "A 2 µW chopper amplifier", author: [{ family: "Kumar" }], issued: { "date-parts": [[2022]] }, abstract: ABSTRACT }, tags: [] }];
  const calls: string[] = [];
  const api: WorkbenchAppApi = {
    invoke: (m, p) => h.call(m, p ?? {}),
    invokeModule: async (moduleId, m) => {
      calls.push(`${moduleId}:${m}`);
      if (moduleId === "research" && m === "library.list") return lib as never;
      return {} as never;
    },
    on: () => () => undefined,
    openUrl: () => undefined,
    download: () => undefined,
    openApp: () => undefined,
    activeTab: { tabId: 1, url: "https://example.org", title: "x", profileId: "p1", workspaceId: null, isPrivate: false },
  };
  return { api, h, calls };
}

const app = (id: string) => rendererModule.apps!.find((a) => a.id === id)!.component as (p: { api: WorkbenchAppApi }) => ReactElement;

describe("module UI", () => {
  it("registers one app per manifest entry, all gated by the module id", () => {
    expect(rendererModule.id).toBe(manifest.id);
    expect(rendererModule.apps!.map((a) => a.id)).toEqual(manifest.apps.map((a) => a.id));
    expect(rendererModule.apps!.every((a) => a.addon === manifest.id)).toBe(true);
  });

  it("Literature Review: create a review, add a library source and see it", async () => {
    const { api } = await harness();
    const origPrompt = globalThis.prompt;
    globalThis.prompt = () => "ECG review";
    render(createElement(app("research.review"), { api }));
    fireEvent.click(await screen.findByText("New review"));
    expect(await screen.findByRole("heading", { name: "ECG review" })).toBeTruthy();
    fireEvent.click(screen.getByText("Add from library"));
    fireEvent.click(await screen.findByText("Add"));
    await waitFor(() => expect(screen.getAllByText("A 2 µW chopper amplifier").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("tab", { name: "Extraction" }));
    fireEvent.click(await screen.findByText("Suggest from abstract"));
    expect(await screen.findByText(/new suggestions? to review/, undefined, { timeout: 4000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Matrix" }));
    expect(await screen.findByText(/not extracted yet/)).toBeTruthy();
    globalThis.prompt = origPrompt;
  });

  it("Discover shows that online features are off instead of contacting anything", async () => {
    const { api, h } = await harness();
    render(createElement(app("research.review"), { api }));
    fireEvent.change(await screen.findByLabelText("Search terms"), { target: { value: "ecg amplifier" } });
    fireEvent.click(screen.getByText("Search"));
    expect(await screen.findByText(/Online features are off/)).toBeTruthy();
    expect(h.calls).toHaveLength(0);
  });

  it("Reference Check, Offline Library and Trail render", async () => {
    const { api } = await harness();
    render(createElement(app("research.verify"), { api }));
    expect(await screen.findByText(/Verify all \(1\)/)).toBeTruthy();
    cleanup();
    render(createElement(app("research.library"), { api }));
    expect(await screen.findByText(/Nothing saved yet/)).toBeTruthy();
    cleanup();
    render(createElement(app("research.trail"), { api }));
    expect(await screen.findByText("The trail is off.")).toBeTruthy();
  });
});
