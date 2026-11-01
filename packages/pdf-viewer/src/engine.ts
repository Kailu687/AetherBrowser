/**
 * Thin, lazily-loaded wrapper around pdf.js. The engine (~1 MB with worker)
 * is only imported the first time a PDF is opened.
 *
 * Security: pdf.js runs PDF parsing in a worker; we disable scripting
 * (`isEvalSupported: false`, no sandbox bundle) and never enable XFA forms.
 */
import type { PDFDocumentProxy } from "pdfjs-dist";

type PdfJs = typeof import("pdfjs-dist");

export interface EngineConfig {
  /** URL of pdf.worker.min.mjs as served to the renderer (e.g. Vite `?url` import). */
  workerSrc?: string;
  /** Override the module loader (tests use the Node "legacy" build). */
  load?: () => Promise<PdfJs>;
}

let config: EngineConfig = {};
let enginePromise: Promise<PdfJs> | undefined;

export function configurePdfEngine(c: EngineConfig): void {
  config = c;
  enginePromise = undefined;
}

export function loadPdfEngine(): Promise<PdfJs> {
  enginePromise ??= (config.load ?? (() => import("pdfjs-dist")))().then((m) => {
    const lib = ((m as unknown as { default?: PdfJs }).default ?? m) as PdfJs;
    if (config.workerSrc) lib.GlobalWorkerOptions.workerSrc = config.workerSrc;
    return lib;
  });
  return enginePromise;
}

export interface OutlineItem {
  title: string;
  page?: number;
  depth: number;
}

export interface PdfInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creationDate?: Date;
  producer?: string;
}

export interface TextMatch {
  page: number;
  /** Offset into that page's text (same coordinates as annotations). */
  index: number;
  length: number;
  snippet: string;
}

export class PdfDocument {
  private textCache = new Map<number, Promise<string>>();

  private constructor(
    readonly proxy: PDFDocumentProxy,
    readonly fingerprint: string,
  ) {}

  static async open(source: Uint8Array | ArrayBuffer | string, opts: { password?: string } = {}): Promise<PdfDocument> {
    const lib = await loadPdfEngine();
    const params = {
      ...(typeof source === "string" ? { url: source } : { data: source instanceof Uint8Array ? source : new Uint8Array(source) }),
      password: opts.password,
      isEvalSupported: false,
      enableXfa: false,
      disableAutoFetch: true,
      useSystemFonts: true,
    };
    try {
      const proxy = await lib.getDocument(params).promise;
      return new PdfDocument(proxy, proxy.fingerprints[0] ?? "unknown");
    } catch (e) {
      const err = e as { name?: string; message?: string };
      if (err.name === "PasswordException") throw new PdfError("This PDF is password-protected.", "password");
      if (err.name === "InvalidPDFException") throw new PdfError("This file is not a valid PDF or is damaged.", "invalid");
      throw new PdfError(`Could not open PDF: ${err.message ?? String(e)}`, "unknown");
    }
  }

  get numPages(): number {
    return this.proxy.numPages;
  }

  /** Stable id for annotations: `pdf:<fingerprint>`. */
  get sourceId(): string {
    return `pdf:${this.fingerprint}`;
  }

  async info(): Promise<PdfInfo> {
    const { info } = (await this.proxy.getMetadata()) as unknown as { info: Record<string, unknown> };
    const str = (k: string) => (typeof info[k] === "string" && (info[k] as string).trim() ? (info[k] as string).trim() : undefined);
    return {
      title: str("Title"),
      author: str("Author"),
      subject: str("Subject"),
      keywords: str("Keywords"),
      producer: str("Producer"),
      creationDate: parsePdfDate(str("CreationDate")),
    };
  }

  /** Plain text of a page; text items are joined with spaces/newlines as pdf.js reports EOL. Cached. */
  pageText(page: number): Promise<string> {
    try {
      this.assertPage(page);
    } catch (e) {
      return Promise.reject(e);
    }
    let p = this.textCache.get(page);
    if (!p) {
      p = this.proxy.getPage(page).then(async (pg) => {
        const content = await pg.getTextContent();
        let out = "";
        for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
          if (item.str === undefined) continue;
          out += item.str + (item.hasEOL ? "\n" : "");
        }
        return out;
      });
      this.textCache.set(page, p);
    }
    return p;
  }

  async search(query: string, opts: { caseSensitive?: boolean; limit?: number } = {}): Promise<TextMatch[]> {
    const q = opts.caseSensitive ? query : query.toLowerCase();
    if (!q.trim()) return [];
    const out: TextMatch[] = [];
    for (let p = 1; p <= this.numPages; p++) {
      const text = await this.pageText(p);
      const hay = opts.caseSensitive ? text : text.toLowerCase();
      for (let i = hay.indexOf(q); i !== -1; i = hay.indexOf(q, i + q.length)) {
        out.push({ page: p, index: i, length: q.length, snippet: text.slice(Math.max(0, i - 40), i + q.length + 40).replace(/\s+/g, " ") });
        if (out.length >= (opts.limit ?? 500)) return out;
      }
    }
    return out;
  }

  async outline(): Promise<OutlineItem[]> {
    const items = await this.proxy.getOutline();
    if (!items) return [];
    const out: OutlineItem[] = [];
    const walk = async (list: typeof items, depth: number) => {
      for (const it of list) {
        let page: number | undefined;
        try {
          const dest = typeof it.dest === "string" ? await this.proxy.getDestination(it.dest) : it.dest;
          if (dest?.[0]) page = (await this.proxy.getPageIndex(dest[0] as never)) + 1;
        } catch {
          page = undefined;
        }
        out.push({ title: it.title, page, depth });
        if (it.items?.length) await walk(it.items, depth + 1);
      }
    };
    await walk(items, 0);
    return out;
  }

  /** Page size in PDF points at scale 1. */
  async pageSize(page: number): Promise<{ width: number; height: number }> {
    this.assertPage(page);
    const vp = (await this.proxy.getPage(page)).getViewport({ scale: 1 });
    return { width: vp.width, height: vp.height };
  }

  /** Render into a canvas (browser only). Returns a cancel function. */
  async render(page: number, canvas: HTMLCanvasElement, scale: number): Promise<{ cancel(): void; done: Promise<void> }> {
    this.assertPage(page);
    const pg = await this.proxy.getPage(page);
    const dpr = globalThis.devicePixelRatio ?? 1;
    const vp = pg.getViewport({ scale: scale * dpr });
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = `${Math.floor(vp.width / dpr)}px`;
    canvas.style.height = `${Math.floor(vp.height / dpr)}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new PdfError("Canvas 2D context unavailable", "unknown");
    const task = pg.render({ canvasContext: ctx, viewport: vp });
    return { cancel: () => task.cancel(), done: task.promise.catch((e: { name?: string }) => (e?.name === "RenderingCancelledException" ? undefined : Promise.reject(e))) };
  }

  async close(): Promise<void> {
    this.textCache.clear();
    await this.proxy.destroy();
  }

  private assertPage(page: number) {
    if (!Number.isInteger(page) || page < 1 || page > this.numPages) throw new PdfError(`Page ${page} is out of range (1–${this.numPages}).`, "range");
  }
}

export class PdfError extends Error {
  constructor(
    message: string,
    readonly kind: "password" | "invalid" | "range" | "unknown",
  ) {
    super(message);
    this.name = "PdfError";
  }
}

/** PDF date strings look like "D:20230115103000+05'30'". */
export function parsePdfDate(s: string | undefined): Date | undefined {
  const m = s?.match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/);
  if (!m) return undefined;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00", tz] = m;
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${se}`;
  if (!tz || tz === "Z") iso += "Z";
  else iso += `${tz.slice(0, 3)}:${tz.replace(/'/g, "").slice(3, 5) || "00"}`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
