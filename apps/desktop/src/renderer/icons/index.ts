/**
 * Theme-provided icon sets. A theme names an icon set (`Theme.iconSet`) and
 * the <Icon> component draws that set's glyph when it has one, falling back
 * to the base stroke icons in components/Icon.tsx otherwise. A set only has
 * to cover the names it wants to restyle, so new themes can ship a handful
 * of icons or a full replacement.
 *
 * Adding a set: create `icons/<id>.ts` exporting an IconSet, list it in
 * ICON_SETS below, and set `iconSet: '<id>'` on the theme in shared/themes.ts.
 */
import { useSyncExternalStore } from 'react';
import { FLIGHT_DECK } from './flight-deck';

/** One SVG shape on the 16px grid. Stroked with currentColor unless `fill` is set. */
export interface IconShape {
  d: string;
  /** Fill with currentColor instead of stroking. */
  fill?: boolean;
  /** Fill and stroke with the theme's second accent (`--accent-2`). */
  accent?: boolean;
  opacity?: number;
  /** Stroke width override for this shape. */
  width?: number;
  /** SVG transform, for reusing one outline rotated or scaled. */
  transform?: string;
}

/** A plain path string is shorthand for one stroked shape. */
export type IconGlyph = string | IconShape[];

export interface IconSet {
  id: string;
  name: string;
  /** Default stroke width for the set (base icons use 1.4). */
  strokeWidth?: number;
  icons: Record<string, IconGlyph>;
}

export const ICON_SETS: Record<string, IconSet> = {
  [FLIGHT_DECK.id]: FLIGHT_DECK,
};

let active: IconSet | null = null;
const listeners = new Set<() => void>();

/** Called by the app whenever the theme changes. Unknown ids select the base icons. */
export function setActiveIconSet(id: string | undefined): void {
  const next = (id && ICON_SETS[id]) || null;
  if (next === active) return;
  active = next;
  for (const l of listeners) l();
}

export function getActiveIconSet(): IconSet | null {
  return active;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useIconSet(): IconSet | null {
  return useSyncExternalStore(subscribe, getActiveIconSet, getActiveIconSet);
}

export function shapesOf(glyph: IconGlyph): IconShape[] {
  return typeof glyph === 'string' ? [{ d: glyph }] : glyph;
}
