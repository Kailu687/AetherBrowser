import type { FocusRule, RuleAction } from './rules.js';

export type FocusMode = 'deep-work' | 'study' | 'research' | 'relaxed' | 'custom';

/**
 * gentle: every option is available immediately.
 * balanced: "continue" and "allow for a while" unlock after a short pause.
 * strict: blocked sites cannot be continued; temporary allowances are short and delayed.
 * Ending the session is always possible: the user stays in control of their computer.
 */
export type Strictness = 'gentle' | 'balanced' | 'strict';

export interface ModeConfig {
  label: string;
  description: string;
  rules: FocusRule[];
  strictness: Strictness;
  /** Rules take effect this many seconds after the session starts. */
  graceSeconds: number;
  /** Interface hints for the shell. */
  hideClutter: boolean;
  muteSiteNotifications: boolean;
  defaultTimer: { workMinutes: number; breakMinutes: number } | null;
}

const SOCIAL = ['instagram.com', 'facebook.com', 'x.com', 'twitter.com', 'tiktok.com', 'snapchat.com', 'threads.net'];
const ENTERTAINMENT = ['netflix.com', 'primevideo.com', 'hotstar.com', 'twitch.tv', '9gag.com'];
const COMMUNICATION = ['web.whatsapp.com', 'mail.google.com', 'outlook.office.com', 'teams.microsoft.com', 'slack.com'];

let seq = 0;
function rules(action: RuleAction, patterns: string[], prefix: string): FocusRule[] {
  return patterns.map((pattern) => ({ id: `${prefix}-${pattern.replace(/[^a-z0-9]+/g, '-')}-${seq++}`, pattern, action }));
}

export function defaultModes(): Record<FocusMode, ModeConfig> {
  seq = 0;
  return {
    'deep-work': {
      label: 'Deep Work',
      description: 'Blocks social feeds and entertainment, warns before YouTube and Reddit, keeps docs and research reachable.',
      rules: [
        ...rules('block', [...SOCIAL, ...ENTERTAINMENT, 'youtube.com/shorts'], 'dw'),
        ...rules('warn', ['youtube.com', 'reddit.com', 'news.ycombinator.com'], 'dw'),
      ],
      strictness: 'balanced',
      graceSeconds: 0,
      hideClutter: true,
      muteSiteNotifications: true,
      defaultTimer: { workMinutes: 50, breakMinutes: 10 },
    },
    study: {
      label: 'Study',
      description: 'Lectures, papers, LMS portals and messaging stay open; Shorts, Reels and social feeds need a second thought.',
      rules: [
        ...rules('warn', ['youtube.com/shorts', 'reddit.com'], 'st'),
        ...rules('block', ['instagram.com', 'facebook.com', 'tiktok.com', 'x.com', 'twitter.com', ...ENTERTAINMENT], 'st'),
        ...rules('allow', ['youtube.com', ...COMMUNICATION], 'st'),
      ],
      strictness: 'balanced',
      graceSeconds: 60,
      hideClutter: false,
      muteSiteNotifications: false,
      defaultTimer: { workMinutes: 25, breakMinutes: 5 },
    },
    research: {
      label: 'Research',
      description: 'Warns before social and entertainment sites so saved sources and papers stay in front.',
      rules: [...rules('warn', [...SOCIAL, ...ENTERTAINMENT, 'youtube.com/shorts', 'reddit.com'], 'rs')],
      strictness: 'gentle',
      graceSeconds: 0,
      hideClutter: true,
      muteSiteNotifications: true,
      defaultTimer: null,
    },
    relaxed: {
      label: 'Relaxed',
      description: 'Normal browsing with no restrictions. Local activity tracking continues if enabled.',
      rules: [],
      strictness: 'gentle',
      graceSeconds: 0,
      hideClutter: false,
      muteSiteNotifications: false,
      defaultTimer: null,
    },
    custom: {
      label: 'Custom',
      description: 'Your own rules, schedule, strictness and session length.',
      rules: [],
      strictness: 'balanced',
      graceSeconds: 0,
      hideClutter: false,
      muteSiteNotifications: false,
      defaultTimer: { workMinutes: 25, breakMinutes: 5 },
    },
  };
}

export interface StrictnessPolicy {
  /** Seconds before "continue" is accepted; null means not offered. */
  continueDelaySeconds: { warn: number | null; block: number | null };
  allowDelaySeconds: number;
  allowOptionsMinutes: number[];
}

export const STRICTNESS: Record<Strictness, StrictnessPolicy> = {
  gentle: { continueDelaySeconds: { warn: 0, block: null }, allowDelaySeconds: 0, allowOptionsMinutes: [5, 15, 30, 60] },
  balanced: { continueDelaySeconds: { warn: 5, block: null }, allowDelaySeconds: 5, allowOptionsMinutes: [5, 15] },
  strict: { continueDelaySeconds: { warn: 15, block: null }, allowDelaySeconds: 15, allowOptionsMinutes: [5] },
};
