/**
 * How time is measured (shown to users on the dashboard):
 * - active: the browser window has OS focus, the tab is the one showing in that window,
 *   and the computer has had keyboard or mouse input within the idle threshold. Measured.
 * - passive: the same tab stays in front after input stops, up to a cap. Inferred: the
 *   person may be reading, or may have walked away.
 * - media: a tab is playing audio (for example a lecture) while not being actively used.
 *   Inferred.
 * Background tabs that are silent are never counted. No URLs paths, page titles,
 * keystrokes, form contents or screenshots are recorded: only the site's registrable
 * domain and its category.
 */
export type ActivityKind = 'active' | 'passive' | 'media';

export type Category = 'education' | 'research' | 'productivity' | 'communication' | 'social' | 'entertainment' | 'uncategorized';

export const CATEGORIES: readonly Category[] = ['education', 'research', 'productivity', 'communication', 'social', 'entertainment', 'uncategorized'];

export const CATEGORY_LABELS: Record<Category, string> = {
  education: 'Learning',
  research: 'Research',
  productivity: 'Productivity & dev',
  communication: 'Communication',
  social: 'Social media',
  entertainment: 'Entertainment',
  uncategorized: 'Uncategorized',
};

export interface ActivitySegment {
  id?: number;
  start: number;
  end: number;
  kind: ActivityKind;
  domain: string;
  category: Category;
  profileId: string;
  workspaceId: string | null;
}

export interface InterventionEntry {
  id?: number;
  at: number;
  domain: string;
  action: 'warn' | 'block';
  /** back | continue | allow | end, or undefined if the prompt was dismissed. */
  resolution?: string;
  mode: string;
  sessionId: string;
}

export interface FocusSessionEntry {
  id: string;
  mode: string;
  goal: string;
  startedAt: number;
  endedAt: number;
  focusedMs: number;
  endReason: string;
  completedWorkBlocks: number;
  interventions: number;
}

export interface Budget {
  id: string;
  target: { type: 'category'; category: Category } | { type: 'domain'; domain: string };
  dailyMinutes: number;
}

export interface ActivitySettings {
  enabled: boolean;
  /** Pause until this time; Infinity-like large values pause until resumed. */
  pausedUntil: number | null;
  idleThresholdSeconds: number;
  /** After input stops, keep counting "passive" time for at most this long. */
  maxPassiveMinutes: number;
  excludedDomains: string[];
  excludedProfiles: string[];
  /** Records older than this are deleted automatically. 0 keeps everything. */
  retentionDays: number;
  categoryOverrides: Record<string, Category>;
  budgets: Budget[];
}

export function defaultActivitySettings(): ActivitySettings {
  return {
    enabled: true,
    pausedUntil: null,
    idleThresholdSeconds: 60,
    maxPassiveMinutes: 10,
    excludedDomains: [],
    excludedProfiles: [],
    retentionDays: 90,
    categoryOverrides: {},
    budgets: [],
  };
}

export interface SegmentQuery {
  from: number;
  to: number;
  profileId?: string;
}
