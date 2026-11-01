import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MainHost, PageContent, ShellEvents } from "@aether/plugin-api";
import { LabNet, type FetchLike } from "../src/net.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type Route = (url: URL, headers: Record<string, string>) => { status?: number; body: unknown } | undefined;

/** Fake fetch answering from a route table; records every URL requested. */
export function fakeFetch(routes: Route[]) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch: FetchLike = async (u, init) => {
    const headers = init?.headers ?? {};
    calls.push({ url: u, headers });
    const url = new URL(u);
    for (const r of routes) {
      const res = r(url, headers);
      if (res) {
        const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
        return { ok: (res.status ?? 200) < 400, status: res.status ?? 200, headers: { get: () => null }, text: async () => text };
      }
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => "not found" };
  };
  return { fetch, calls };
}

export function testNet(routes: Route[], online = true) {
  const f = fakeFetch(routes);
  const log: unknown[] = [];
  const net = new LabNet({ fetch: f.fetch, isOnline: () => online, sleep: async () => undefined, log: (e) => log.push(e) });
  return { net, calls: f.calls, log };
}

type Handler = (payload: unknown, ctx: { windowId: number; profileId: string; isPrivate: boolean }) => unknown;

export function fakeHost(opts: { routes?: Route[]; page?: PageContent; ai?: (req: { system?: string; prompt: string; scope: string }) => { text: string } | null; savePage?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  const kv = new Map<string, unknown>();
  const handlers = new Map<string, Handler>();
  const listeners: Partial<Record<keyof ShellEvents, Array<(p: unknown) => void>>> = {};
  const f = fakeFetch(opts.routes ?? []);
  const secrets = new Map<string, string>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const dataDir = mkdtempSync(join(tmpdir(), "module-research-"));
  const aiCalls: Array<{ scope: string; prompt: string }> = [];
  const host = {
    moduleId: "aether.module.research",
    dataDir,
    storage: {
      db,
      migrate(ms: Array<{ version: number; up: string }>) {
        for (const m of ms) db.exec(m.up);
      },
      kv: {
        get: (k: string, p?: string) => structuredClone(kv.get(`${p}:${k}`)),
        set: (k: string, v: unknown, p?: string) => void kv.set(`${p}:${k}`, structuredClone(v)),
        delete: (k: string, p?: string) => void kv.delete(`${p}:${k}`),
      },
    },
    ipc: { handle: (m: string, h: Handler) => void handlers.set(m, h), emit: (event: string, payload: unknown) => void emitted.push({ event, payload }) },
    events: { on: (n: keyof ShellEvents, l: (p: unknown) => void) => ((listeners[n] ??= []).push(l), () => undefined) },
    profiles: { list: () => [{ id: "p1", name: "Main", color: "#000", partition: "persist:p1", isPrivate: false }], get: () => null },
    tabs: {
      getActive: () => (opts.page ? { tabId: 7, windowId: 1, url: opts.page.url, title: opts.page.title, profileId: "p1", workspaceId: "ws1", isPrivate: false } : null),
      getPageContent: async () => opts.page ?? null,
      savePage: opts.savePage
        ? async (_tab: number, file: string) => {
            const { writeFileSync } = await import("node:fs");
            writeFileSync(file, "MIME-Version: 1.0\r\nContent-Type: multipart/related\r\n\r\narchived");
            return true;
          }
        : undefined,
    },
    net: { fetch: f.fetch },
    secrets: { available: true, get: (k: string) => secrets.get(k) ?? null, set: (k: string, v: string) => void secrets.set(k, v), delete: (k: string) => void secrets.delete(k) },
    ai: opts.ai ? { run: async (req: { system?: string; prompt: string; scope: string }) => (aiCalls.push(req), opts.ai!(req)) } : undefined,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
  } as unknown as MainHost;
  const ctx = { windowId: 1, profileId: "p1", isPrivate: false };
  const call = async <T = any>(method: string, payload: unknown = {}, c = ctx): Promise<T> => {
    const h = handlers.get(method);
    if (!h) throw new Error(`no handler ${method}`);
    return (await h(payload, c)) as T;
  };
  const emit = <K extends keyof ShellEvents>(n: K, p: ShellEvents[K]) => listeners[n]?.forEach((l) => l(p));
  return { host, db, call, emit, calls: f.calls, secrets, emitted, dataDir, aiCalls };
}

// ---------------------------------------------------------------- fixtures

export const CROSSREF_WORK = {
  DOI: "10.1109/CVPR.2016.90",
  type: "proceedings-article",
  title: ["Deep Residual Learning for Image Recognition"],
  author: [{ given: "Kaiming", family: "He" }, { given: "Xiangyu", family: "Zhang" }, { given: "Shaoqing", family: "Ren" }, { given: "Jian", family: "Sun" }],
  "container-title": ["2016 IEEE Conference on Computer Vision and Pattern Recognition (CVPR)"],
  issued: { "date-parts": [[2016, 6]] },
  page: "770-778",
  "is-referenced-by-count": 150000,
  URL: "https://doi.org/10.1109/cvpr.2016.90",
};

export const OPENALEX_WORK = {
  id: "https://openalex.org/W2194775991",
  doi: "https://doi.org/10.1109/cvpr.2016.90",
  title: "Deep Residual Learning for Image Recognition",
  publication_year: 2016,
  publication_date: "2016-06-01",
  type: "article",
  authorships: [{ author: { display_name: "Kaiming He" } }, { author: { display_name: "Xiangyu Zhang" } }],
  primary_location: { source: { display_name: "CVPR" }, landing_page_url: "https://doi.org/10.1109/cvpr.2016.90" },
  best_oa_location: { pdf_url: "https://arxiv.org/pdf/1512.03385" },
  cited_by_count: 200000,
  abstract_inverted_index: { Deeper: [0], neural: [1], networks: [2], are: [3], more: [4], difficult: [5], to: [6], train: [7] },
  is_retracted: false,
};

export const ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
<opensearch:totalResults>1</opensearch:totalResults>
<entry>
<id>http://arxiv.org/abs/1512.03385v1</id>
<published>2015-12-10T19:51:55Z</published>
<title>Deep Residual Learning for Image Recognition</title>
<summary>Deeper neural networks are more difficult to train. We present a residual learning framework.</summary>
<author><name>Kaiming He</name></author>
<author><name>Xiangyu Zhang</name></author>
<arxiv:doi>10.1109/CVPR.2016.90</arxiv:doi>
<arxiv:primary_category term="cs.CV"/>
</entry>
</feed>`;

export const ABSTRACT =
  "This paper investigates low-power analog front ends for wearable ECG sensing. We propose a chopper-stabilised instrumentation amplifier using a capacitively coupled input stage. The prototype was fabricated in 180 nm CMOS and evaluated on the MIT-BIH arrhythmia dataset. Results show that the amplifier achieves an input-referred noise of 1.2 µVrms while consuming 2.1 µW. However, our method does not address motion artefacts during exercise. Future work will investigate adaptive filtering for motion artefacts.";
