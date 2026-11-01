/**
 * Browser themes. One token set drives the privileged UI (CSS variables),
 * the native title-bar controls and the built-in aether:// pages, so a
 * theme looks the same everywhere. Themes are plain data: cheap to switch,
 * nothing to download.
 */

export interface ThemeTokens {
  bg: string;
  chrome: string;
  chrome2: string;
  surface: string;
  surface2: string;
  line: string;
  fg: string;
  muted: string;
  accent: string;
  /** Second signature colour (gradients, highlights). */
  accent2: string;
  danger: string;
  ok: string;
  /** Text on top of accent-coloured buttons. */
  onAccent: string;
}

export interface Theme {
  id: string;
  name: string;
  tagline: string;
  mode: 'dark' | 'light';
  tokens: ThemeTokens;
  /** UI font stack. */
  font: string;
  /** Font for labels, numbers and small caps text. */
  labelFont: string;
  radius: number;
  /** Icon set id from src/renderer/icons (omit for the base icons). */
  iconSet?: string;
}

const SEGOE = "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif";
// Bahnschrift ships with Windows 10/11 and has the DIN look of cockpit labels.
const DIN = "Bahnschrift, 'DIN Alternate', 'Barlow Semi Condensed', 'Segoe UI', system-ui, sans-serif";

export const THEMES: Record<string, Theme> = {
  aether: {
    id: 'aether',
    name: 'AETHER',
    tagline: 'The signature look: deep space with an aurora edge',
    mode: 'dark',
    font: SEGOE,
    labelFont: SEGOE,
    radius: 10,
    tokens: {
      bg: '#0a0c16',
      chrome: '#0e1120',
      chrome2: '#141829',
      surface: '#1a1f33',
      surface2: '#232a42',
      line: '#262d47',
      fg: '#e8eaf6',
      muted: '#8a91b4',
      accent: '#8b7dff',
      accent2: '#35e0d0',
      danger: '#ff6b81',
      ok: '#35e0a1',
      onAccent: '#ffffff',
    },
  },
  aviation: {
    id: 'aviation',
    name: 'Aviation',
    tagline: 'Glass cockpit and spaceflight: aircraft and rocket icons, lit push-buttons, flight-strip tabs, instrument new tab',
    mode: 'dark',
    font: DIN,
    labelFont: DIN,
    radius: 4,
    iconSet: 'flight-deck',
    tokens: {
      bg: '#070b0f',
      chrome: '#0c1217',
      chrome2: '#111a21',
      surface: '#16222b',
      surface2: '#1e2e39',
      line: '#263946',
      fg: '#d8e4ec',
      muted: '#7b909f',
      accent: '#ffb000',
      accent2: '#3ddc84',
      danger: '#ff5a4f',
      ok: '#3ddc84',
      onAccent: '#14100a',
    },
  },
  daylight: {
    id: 'daylight',
    name: 'Daylight',
    tagline: 'Clean and bright for well-lit rooms',
    mode: 'light',
    font: SEGOE,
    labelFont: SEGOE,
    radius: 10,
    tokens: {
      bg: '#f5f6fa',
      chrome: '#e8eaf1',
      chrome2: '#f7f8fb',
      surface: '#ffffff',
      surface2: '#eef0f6',
      line: '#dadde8',
      fg: '#141722',
      muted: '#5b6378',
      accent: '#4f5df0',
      accent2: '#0ea5a0',
      danger: '#d93a4f',
      ok: '#14965f',
      onAccent: '#ffffff',
    },
  },
  midnight: {
    id: 'midnight',
    name: 'Midnight',
    tagline: 'True black, easy on OLED screens and late nights',
    mode: 'dark',
    font: SEGOE,
    labelFont: SEGOE,
    radius: 10,
    tokens: {
      bg: '#000000',
      chrome: '#050506',
      chrome2: '#0b0b0d',
      surface: '#141417',
      surface2: '#1d1d21',
      line: '#232328',
      fg: '#e6e6ea',
      muted: '#86868f',
      accent: '#5eead4',
      accent2: '#818cf8',
      danger: '#f87171',
      ok: '#4ade80',
      onAccent: '#04110f',
    },
  },
  paper: {
    id: 'paper',
    name: 'Paper',
    tagline: 'Warm and low-glare for long reading sessions',
    mode: 'light',
    font: SEGOE,
    labelFont: SEGOE,
    radius: 8,
    tokens: {
      bg: '#f4efe4',
      chrome: '#e9e1d0',
      chrome2: '#f3ecdd',
      surface: '#fbf7ee',
      surface2: '#efe7d6',
      line: '#d9cdb5',
      fg: '#2b2419',
      muted: '#75684f',
      accent: '#b5562a',
      accent2: '#4d7c5a',
      danger: '#b3261e',
      ok: '#3f7d4f',
      onAccent: '#fffaf2',
    },
  },
  contrast: {
    id: 'contrast',
    name: 'High contrast',
    tagline: 'Maximum legibility with strong outlines',
    mode: 'dark',
    font: SEGOE,
    labelFont: SEGOE,
    radius: 6,
    tokens: {
      bg: '#000000',
      chrome: '#000000',
      chrome2: '#000000',
      surface: '#0a0a0a',
      surface2: '#1a1a1a',
      line: '#ffffff',
      fg: '#ffffff',
      muted: '#d0d0d0',
      accent: '#ffee00',
      accent2: '#00e5ff',
      danger: '#ff6060',
      ok: '#5cff7a',
      onAccent: '#000000',
    },
  },
};

export const THEME_IDS = ['system', ...Object.keys(THEMES)] as const;
export const DEFAULT_THEME = 'aether';

/** "system" follows the OS: AETHER when dark, Daylight when light. */
export function resolveTheme(id: string | undefined, osDark: boolean): Theme {
  if (!id || id === 'system') return osDark ? THEMES.aether : THEMES.daylight;
  return THEMES[id] ?? THEMES[DEFAULT_THEME];
}

/** CSS custom properties for a theme, as `--name: value;` declarations. */
export function themeCss(theme: Theme): string {
  const t = theme.tokens;
  return [
    `--bg:${t.bg}`,
    `--chrome:${t.chrome}`,
    `--chrome-2:${t.chrome2}`,
    `--surface:${t.surface}`,
    `--surface-2:${t.surface2}`,
    `--line:${t.line}`,
    `--fg:${t.fg}`,
    `--muted:${t.muted}`,
    `--accent:${t.accent}`,
    `--accent-2:${t.accent2}`,
    `--danger:${t.danger}`,
    `--ok:${t.ok}`,
    `--on-accent:${t.onAccent}`,
    `--radius:${theme.radius}px`,
    `--font:${theme.font}`,
    `--label-font:${theme.labelFont}`,
    `color-scheme:${theme.mode}`,
  ].join(';');
}
