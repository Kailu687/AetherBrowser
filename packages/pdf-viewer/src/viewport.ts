/** Pure layout math for the viewer, kept separate so it is testable without a DOM. */

export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function zoomIn(z: number): number {
  return ZOOM_STEPS.find((s) => s > z + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
}
export function zoomOut(z: number): number {
  return [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6) ?? ZOOM_STEPS[0]!;
}
export const fitWidth = (pageWidthPt: number, containerPx: number, margin = 24) => Math.max(0.1, (containerPx - margin) / pageWidthPt);
export const fitPage = (page: { width: number; height: number }, container: { width: number; height: number }, margin = 24) =>
  Math.max(0.1, Math.min((container.width - margin) / page.width, (container.height - margin) / page.height));

/** Pages whose vertical extent intersects [scrollTop - overscan, scrollTop + viewport + overscan]. */
export function visiblePages(heights: number[], scrollTop: number, viewport: number, gap = 12, overscan = 1): { first: number; last: number; offsets: number[] } {
  const offsets: number[] = [];
  let y = 0;
  for (const h of heights) {
    offsets.push(y);
    y += h + gap;
  }
  let first = heights.length - 1;
  let last = 0;
  heights.forEach((h, i) => {
    const top = offsets[i]!;
    if (top + h >= scrollTop && top <= scrollTop + viewport) {
      first = Math.min(first, i);
      last = Math.max(last, i);
    }
  });
  if (first > last) first = last = 0;
  return { first: Math.max(0, first - overscan) + 1, last: Math.min(heights.length - 1, last + overscan) + 1, offsets };
}

/** "1-3, 5, 8-" → [1,2,3,5,8,...,n]. Invalid parts are ignored. */
export function parsePageRange(spec: string, numPages: number): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? +m[1] : 1;
      const b = m[2] ? +m[2] : numPages;
      for (let p = Math.max(1, a); p <= Math.min(numPages, b); p++) out.add(p);
    } else if (/^\d+$/.test(part) && +part >= 1 && +part <= numPages) out.add(+part);
  }
  return [...out].sort((x, y) => x - y);
}
