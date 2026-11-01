import { describe, expect, it } from 'vitest';
import { ICON_SETS, getActiveIconSet, setActiveIconSet, shapesOf } from '../../src/renderer/icons';
import { THEMES } from '../../src/shared/themes';

// Names the shell's toolbar, tab strip and sidebar draw today.
const CHROME_ICONS = ['back', 'forward', 'reload', 'stop', 'plus', 'star', 'split', 'sidebar', 'download', 'history', 'bookmark', 'notes', 'settings', 'speaker', 'muted', 'mask', 'user'];

describe('icon sets', () => {
  it('every theme that names an icon set points at a registered one', () => {
    for (const theme of Object.values(THEMES)) {
      if (theme.iconSet) expect(ICON_SETS[theme.iconSet], theme.id).toBeDefined();
    }
  });

  it('the aviation theme uses the flight-deck set, which covers the browser chrome', () => {
    const set = ICON_SETS[THEMES.aviation.iconSet!];
    for (const name of CHROME_ICONS) expect(set.icons[name], name).toBeDefined();
  });

  it('every glyph is non-empty path data on the 16px grid', () => {
    for (const set of Object.values(ICON_SETS)) {
      for (const [name, glyph] of Object.entries(set.icons)) {
        const shapes = shapesOf(glyph);
        expect(shapes.length, name).toBeGreaterThan(0);
        for (const s of shapes) {
          expect(s.d, name).toMatch(/^M/);
          const nums = (s.d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
          for (const n of nums) expect(Math.abs(n), `${set.id}/${name}`).toBeLessThanOrEqual(16);
        }
      }
    }
  });

  it('switching themes swaps the active set, and unknown ids fall back to base icons', () => {
    setActiveIconSet('flight-deck');
    expect(getActiveIconSet()?.id).toBe('flight-deck');
    setActiveIconSet(undefined);
    expect(getActiveIconSet()).toBeNull();
    setActiveIconSet('no-such-set');
    expect(getActiveIconSet()).toBeNull();
  });
});
