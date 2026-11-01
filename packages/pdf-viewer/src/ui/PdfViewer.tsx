import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { loadPdfEngine, PdfDocument, type TextMatch } from "../engine.js";
import { fitWidth, visiblePages, zoomIn, zoomOut } from "../viewport.js";
import { offsetsFromRange, textIndex, wrapRange } from "@aether/annotations/dom";

export interface PdfHighlight {
  id: string;
  page: number;
  start: number;
  end: number;
  color: string;
}

export interface PdfViewerProps {
  /** Bytes or a URL the renderer may fetch. */
  source: Uint8Array | string;
  fileName?: string;
  /** Highlights already anchored against each page's text-layer text. */
  highlights?: PdfHighlight[];
  /** Called when the user highlights a selection; `text` is the page's text-layer text. */
  onHighlight?(h: { page: number; text: string; start: number; end: number; documentId: string }): void;
  onOpen?(doc: PdfDocument): void;
  /** Restore/persist reading position (page + zoom) per document. */
  initialPage?: number;
  onPositionChange?(pos: { page: number; zoom: number }): void;
}

const GAP = 12;

/**
 * Virtualised PDF viewer: only pages near the viewport get a canvas and a
 * text layer, so 500-page datasheets stay light on memory.
 */
export function PdfViewer({ source, fileName, highlights = [], onHighlight, onOpen, initialPage = 1, onPositionChange }: PdfViewerProps) {
  const [doc, setDoc] = useState<PdfDocument>();
  const [error, setError] = useState<string>();
  const [sizes, setSizes] = useState<Array<{ width: number; height: number }>>([]);
  const [zoom, setZoom] = useState(1);
  const [range, setRange] = useState({ first: 1, last: 1 });
  const [page, setPage] = useState(initialPage);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<TextMatch[]>([]);
  const [matchIdx, setMatchIdx] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);

  useEffect(() => {
    let live = true;
    let opened: PdfDocument | undefined;
    setError(undefined);
    PdfDocument.open(source)
      .then(async (d) => {
        opened = d;
        if (!live) return d.close();
        const s: Array<{ width: number; height: number }> = [];
        for (let p = 1; p <= d.numPages; p++) s.push(await d.pageSize(p));
        setSizes(s);
        setDoc(d);
        onOpen?.(d);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
      void opened?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // Fit width once on open.
  useLayoutEffect(() => {
    if (!sizes.length || fitted.current || !scroller.current) return;
    fitted.current = true;
    const w = scroller.current.clientWidth;
    if (w > 0) setZoom(Math.min(2, fitWidth(sizes[0]!.width, w)));
  }, [sizes]);

  const heights = sizes.map((s) => s.height * zoom);
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el || !heights.length) return;
    const v = visiblePages(heights, el.scrollTop, el.clientHeight, GAP);
    setRange({ first: v.first, last: v.last });
    const centre = el.scrollTop + el.clientHeight / 3;
    const current = v.offsets.findIndex((o, i) => centre >= o && centre < o + heights[i]! + GAP) + 1;
    if (current > 0 && current !== page) {
      setPage(current);
      onPositionChange?.({ page: current, zoom });
    }
  }, [heights, page, zoom, onPositionChange]);

  useEffect(onScroll, [zoom, sizes.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const goTo = (p: number) => {
    if (!doc) return;
    const target = Math.min(Math.max(1, p), doc.numPages);
    const { offsets } = visiblePages(heights, 0, 0, GAP);
    scroller.current?.scrollTo({ top: offsets[target - 1] ?? 0 });
    setPage(target);
  };

  useEffect(() => {
    if (initialPage > 1 && sizes.length) goTo(initialPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizes.length]);

  const runSearch = async () => {
    if (!doc) return;
    const m = await doc.search(query);
    setMatches(m);
    setMatchIdx(0);
    if (m[0]) goTo(m[0].page);
  };

  const highlightSelection = () => {
    const sel = globalThis.getSelection?.();
    if (!sel || sel.isCollapsed || !doc) return;
    const range = sel.getRangeAt(0);
    const layer = (range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest<HTMLElement>(".ae-text-layer");
    if (!layer) return;
    const off = offsetsFromRange(layer, range);
    if (!off) return;
    onHighlight?.({ page: Number(layer.dataset.page), text: textIndex(layer).text, ...off, documentId: doc.sourceId });
    sel.removeAllRanges();
  };

  if (error) {
    return (
      <div role="alert" className="ae-pdf-error">
        <strong>Couldn't open {fileName ?? "this PDF"}.</strong> {error}
      </div>
    );
  }

  return (
    <div className="ae-pdf" onKeyDown={(e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) (e.preventDefault(), setZoom(zoomIn));
      if ((e.ctrlKey || e.metaKey) && e.key === "-") (e.preventDefault(), setZoom(zoomOut));
    }}>
      <div className="ae-pdf-toolbar" role="toolbar" aria-label="PDF controls">
        <button onClick={() => goTo(page - 1)} disabled={page <= 1} aria-label="Previous page">‹</button>
        <input aria-label="Page number" value={page} inputMode="numeric" onChange={(e) => goTo(Number(e.target.value) || 1)} style={{ width: "3em" }} />
        <span>/ {doc?.numPages ?? "…"}</span>
        <button onClick={() => goTo(page + 1)} disabled={!doc || page >= doc.numPages} aria-label="Next page">›</button>
        <button onClick={() => setZoom(zoomOut)} aria-label="Zoom out">−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(zoomIn)} aria-label="Zoom in">+</button>
        <button onClick={() => scroller.current && sizes[0] && setZoom(fitWidth(sizes[0].width, scroller.current.clientWidth))}>Fit width</button>
        <form onSubmit={(e) => (e.preventDefault(), void runSearch())}>
          <input type="search" aria-label="Find in PDF" placeholder="Find" value={query} onChange={(e) => setQuery(e.target.value)} />
        </form>
        {matches.length > 0 && (
          <span>
            {matchIdx + 1}/{matches.length}
            <button aria-label="Next match" onClick={() => {
              const n = (matchIdx + 1) % matches.length;
              setMatchIdx(n);
              goTo(matches[n]!.page);
            }}>↓</button>
          </span>
        )}
        {onHighlight && <button onClick={highlightSelection}>Highlight</button>}
      </div>
      <div ref={scroller} className="ae-pdf-scroll" onScroll={onScroll} style={{ overflow: "auto", height: "100%" }}>
        {doc &&
          sizes.map((s, i) => (
            <div key={i} className="ae-pdf-page" style={{ width: s.width * zoom, height: s.height * zoom, marginBottom: GAP, position: "relative" }}>
              {i + 1 >= range.first && i + 1 <= range.last && (
                <PageView doc={doc} page={i + 1} zoom={zoom} highlights={highlights.filter((h) => h.page === i + 1)} />
              )}
            </div>
          ))}
      </div>
    </div>
  );
}

function PageView({ doc, page, zoom, highlights }: { doc: PdfDocument; page: number; zoom: number; highlights: PdfHighlight[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [textReady, setTextReady] = useState(0);

  useEffect(() => {
    let cancel: (() => void) | undefined;
    let live = true;
    (async () => {
      if (!canvas.current) return;
      const task = await doc.render(page, canvas.current, zoom);
      cancel = task.cancel;
      await task.done;
      const lib = await loadPdfEngine();
      const pg = await doc.proxy.getPage(page);
      if (!live || !layer.current) return;
      layer.current.replaceChildren();
      layer.current.style.setProperty("--scale-factor", String(zoom));
      const tl = new lib.TextLayer({ textContentSource: pg.streamTextContent(), container: layer.current, viewport: pg.getViewport({ scale: zoom }) });
      await tl.render();
      if (live) setTextReady((n) => n + 1);
    })().catch(() => undefined);
    return () => {
      live = false;
      cancel?.();
    };
  }, [doc, page, zoom]);

  // Draw highlights into the text layer once it exists.
  useEffect(() => {
    if (!layer.current || !textReady) return;
    const marks = highlights.flatMap((h) => wrapRange(layer.current!, h.start, h.end, { class: `ae-hl ae-hl-${h.color}`, "data-ann": h.id }));
    return () => {
      for (const m of marks) {
        const p = m.parentNode;
        if (!p) continue;
        while (m.firstChild) p.insertBefore(m.firstChild, m);
        p.removeChild(m);
      }
    };
  }, [highlights, textReady]);

  return (
    <>
      <canvas ref={canvas} aria-label={`Page ${page}`} />
      <div ref={layer} className="ae-text-layer textLayer" data-page={page} style={{ position: "absolute", inset: 0 }} />
    </>
  );
}
