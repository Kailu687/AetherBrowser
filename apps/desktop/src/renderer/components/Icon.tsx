/** Minimal inline icon set (stroke icons, 16px grid). Themes can restyle any of these through an icon set (see ../icons). */
import { shapesOf, useIconSet } from '../icons';

const paths: Record<string, string> = {
  back: 'M10 3 5 8l5 5',
  forward: 'M6 3l5 5-5 5',
  reload: 'M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3',
  stop: 'M4 4l8 8M12 4l-8 8',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  plus: 'M8 3v10M3 8h10',
  star: 'M8 2.5l1.7 3.5 3.8.5-2.8 2.6.7 3.8L8 11.1 4.6 12.9l.7-3.8L2.5 6.5l3.8-.5z',
  split: 'M2.5 3.5h11v9h-11zM8 3.5v9',
  sidebar: 'M2.5 3.5h11v9h-11zM10 3.5v9',
  download: 'M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10',
  history: 'M8 4.5V8l2.5 1.5M2.8 8a5.2 5.2 0 1 0 1.5-3.7M2.5 2.5v2.5H5',
  bookmark: 'M4 2.5h8v11l-4-3-4 3z',
  notes: 'M3.5 2.5h9v11h-9zM5.5 5.5h5M5.5 8h5M5.5 10.5h3',
  layers: 'M8 2.5 13.5 5.5 8 8.5 2.5 5.5zM2.5 8.5 8 11.5l5.5-3M2.5 11 8 14l5.5-3',
  settings: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  lock: 'M4.5 7V5.5a3.5 3.5 0 0 1 7 0V7M3.5 7h9v6.5h-9z',
  info: 'M8 7.5v4M8 5v.01M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z',
  speaker: 'M2.5 6h2.5L8.5 3v10L5 10H2.5zM11 5.5a3.5 3.5 0 0 1 0 5',
  muted: 'M2.5 6h2.5L8.5 3v10L5 10H2.5zM11 6l3 4M14 6l-3 4',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.5 10.5l3 3',
  window: 'M2.5 3.5h11v9h-11zM2.5 6h11',
  mask: 'M2 6.5c2-1.5 10-1.5 12 0-.5 3-2.5 4-4 4-1 0-1.5-1-2-1s-1 1-2 1c-1.5 0-3.5-1-4-4z',
  moon: 'M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z',
  pin: 'M6 2.5h4l-.5 4 2 2v1h-7v-1l2-2zM8 9.5v4',
  trash: 'M3 4.5h10M6 4.5v-2h4v2M4.5 4.5l.5 9h6l.5-9',
  folder: 'M2.5 4.5h4l1 1.5h6v7h-11z',
  external: 'M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4',
  chevron: 'M4 6l4 4 4-4',
  check: 'M3 8.5l3 3 7-7',
  bolt: 'M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z',
  book: 'M2.5 3.5c2-1 4-1 5.5.5 1.5-1.5 3.5-1.5 5.5-.5v9c-2-1-4-1-5.5.5-1.5-1.5-3.5-1.5-5.5-.5zM8 4v9.5',
  reader: 'M3.5 2.5h9v11h-9zM5.5 5h5M5.5 7.5h5M5.5 10h3',
  key: 'M5.5 10.5a3 3 0 1 1 2.6-4.5H14v2.5h-1.5V10H11V8.5H8.1a3 3 0 0 1-2.6 2zM5 8.5v.01',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  palette: 'M8 1.5a6.5 6.5 0 0 0 0 13c1 0 1.5-.6 1.5-1.4 0-1.1-.9-1.3-.9-2.1 0-.7.6-1.2 1.4-1.2h1.6a2.9 2.9 0 0 0 2.9-2.9C14.5 4.2 11.6 1.5 8 1.5zM4.75 7.5v.01M6.5 4.75v.01M9.75 4.75v.01M11.5 7.25v.01',
  menu: 'M8 2.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM8 7a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM8 11.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  // Feature-module sidebar buttons (an icon set can replace these).
  'panel:notebook': 'M4 2.5h8.5v11H4zM2.5 5h3M2.5 8h3M2.5 11h3M7 5.5h3.5M7 8h3.5',
  'panel:library': 'M2.5 13.5h11M3.5 3.5h2v10h-2zM6.5 2.5h2v11h-2zM9.75 4.25l1.9-.6 2.9 9.3-1.9.6z',
  'panel:writer': 'M11 2.5l2.5 2.5L6 12.5l-3.5 1 1-3.5zM9.5 4l2.5 2.5',
  'panel:calculator': 'M3.5 1.5h9v13h-9zM5.5 3.5h5v2.5h-5zM5.5 8.5v.01M8 8.5v.01M10.5 8.5v.01M5.5 11v.01M8 11v.01M10.5 11v.01M5.5 13v.01M8 13v.01M10.5 13v.01',
  'panel:assistant': 'M8 1.5l1.4 3.6L13 6.5 9.4 7.9 8 11.5 6.6 7.9 3 6.5l3.6-1.4zM12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
  'panel:focus': 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 10.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5zM8 8v.01',
  'panel:privacy': 'M8 1.5 13 3.5v4c0 3-2.2 5.5-5 7-2.8-1.5-5-4-5-7v-4zM5.75 8l1.6 1.6 3-3.2',
  'panel:time': 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 4.5V8l2.5 1.5',
  user: 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 14c.5-3 2.7-4.5 5.5-4.5s5 1.5 5.5 4.5',
};

export function Icon({ name, size = 16, className }: { name: keyof typeof paths | string; size?: number; className?: string }) {
  const set = useIconSet();
  const glyph = set?.icons[name];
  if (glyph) {
    const sw = set.strokeWidth ?? 1.4;
    return (
      <svg className={className ? `icon ${className}` : 'icon'} data-icon={name} data-set={set.id} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {shapesOf(glyph).map((s, i) => {
          const color = s.accent ? 'var(--accent-2)' : 'currentColor';
          return s.fill ? (
            // Inline style so the "on" button state (which tints stroked shapes) leaves solid shapes solid.
            <path key={i} d={s.d} stroke="none" style={{ fill: color }} opacity={s.opacity} transform={s.transform} />
          ) : (
            <path key={i} d={s.d} stroke={color} strokeWidth={s.width} opacity={s.opacity} transform={s.transform} />
          );
        })}
      </svg>
    );
  }
  const d = paths[name] ?? paths.info;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** True when the active icon set or the base set has a glyph for `name`. */
export function useHasIcon(name: string): boolean {
  const set = useIconSet();
  return Boolean(set?.icons[name] ?? paths[name]);
}
