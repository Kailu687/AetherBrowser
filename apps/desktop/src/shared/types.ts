import type { Theme } from './themes';

/**
 * Types shared by the main process, the preload bridge and the privileged UI.
 * Everything crossing IPC is plain JSON.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TabState {
  id: number;
  url: string;
  title: string;
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  audible: boolean;
  muted: boolean;
  pinned: boolean;
  /** Discarded to save memory; reloads when activated. */
  sleeping: boolean;
  crashed: boolean;
  unresponsive: boolean;
  zoom: number;
  error: { code: number; description: string; url: string } | null;
  secure: boolean;
  groupId: string | null;
}

export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export interface TabGroup {
  id: string;
  title: string;
  color: GroupColor;
  collapsed: boolean;
}

export interface ProfileSummary {
  id: string;
  name: string;
  color: string;
  icon: string;
  searchEngine: string;
  closeBehavior: 'ask' | 'save' | 'discard';
  restoreOnStartup: boolean;
  openWindows: number;
  savedWindows: number;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  color: string;
  icon: string;
  tabCount: number;
  updatedAt: number;
  /** Window id where this workspace is currently open, if any. */
  openIn: number | null;
}

export interface SplitState {
  leftTabId: number;
  rightTabId: number;
  ratio: number;
}

export interface WindowState {
  windowId: number;
  platform: string;
  isPrivate: boolean;
  profile: ProfileSummary;
  profiles: ProfileSummary[];
  workspace: { id: string; name: string; color: string } | null;
  workspaces: WorkspaceSummary[];
  tabs: TabState[];
  groups: TabGroup[];
  activeTabId: number | null;
  split: SplitState | null;
  bookmarked: boolean;
  bookmarksBar: boolean;
  /** Changes whenever bookmarks change. */
  bookmarksRev: number;
  /** Offer to save a password for a tab after the user signed in. The password itself never reaches the UI. */
  loginPrompt: { tabId: number; site: string; username: string; update: boolean } | null;
  /** Saved logins for the active tab's site (0 in private windows). */
  savedLogins: number;
  sleepAfterMinutes: number;
  themeId: string;
  theme: Theme;
}

export interface Suggestion {
  kind: 'history' | 'bookmark' | 'search' | 'url' | 'bang' | 'tab' | 'calc';
  /** For 'calc': the value Enter copies. */
  copy?: string;
  title: string;
  url: string;
  detail?: string;
  tabId?: number;
}

export interface DownloadItemState {
  id: number;
  url: string;
  filename: string;
  path: string;
  totalBytes: number;
  receivedBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  paused: boolean;
  startedAt: number;
}

export interface PermissionPrompt {
  requestId: number;
  tabId: number;
  origin: string;
  permission: string;
}

export interface SavedWindowSummary {
  id: string;
  title: string;
  tabCount: number;
  updatedAt: number;
  workspaceName: string | null;
}

/** Commands triggered by keyboard shortcuts in main and executed in the UI. */
export type UiCommand =
  | 'focus-address'
  | 'find'
  | 'command-palette'
  | 'toggle-sidebar'
  | 'panel:history'
  | 'panel:bookmarks'
  | 'panel:downloads'
  | 'panel:notes'
  | 'panel:passwords'
  | 'panel:settings'
  | 'panel:privacy'
  | 'escape';

/** Invoke channels exposed by the preload bridge. Keep in sync with main/ipc.ts. */
export const INVOKE_CHANNELS = [
  'ui:ready',
  'ui:layout',
  'ui:overlay',
  'tab:new',
  'tab:close',
  'tab:activate',
  'tab:navigate',
  'tab:back',
  'tab:forward',
  'tab:reload',
  'tab:stop',
  'tab:move',
  'tab:pin',
  'tab:mute',
  'tab:duplicate',
  'tab:reopen-closed',
  'tab:zoom',
  'tab:find',
  'tab:stop-find',
  'tab:print',
  'tab:devtools',
  'tab:sleep',
  'tab:reader',
  'tab:context-menu',
  'group:create',
  'group:update',
  'group:menu',
  'tab:set-group',
  'split:set',
  'split:toggle',
  'split:ratio',
  'split:close',
  'omnibox:suggest',
  'window:new',
  'window:new-private',
  'window:close',
  'window:saved-list',
  'window:open-saved',
  'window:delete-saved',
  'profile:create',
  'profile:update',
  'profile:open',
  'profile:delete',
  'profile:export',
  'workspace:create-from-window',
  'workspace:switch',
  'workspace:open-in-new-window',
  'workspace:detach',
  'workspace:rename',
  'workspace:delete',
  'workspace:get-notes',
  'workspace:set-notes',
  'history:list',
  'history:delete',
  'history:clear',
  'bookmarks:list',
  'bookmarks:toggle',
  'bookmarks:add',
  'bookmarks:update',
  'bookmarks:delete',
  'bookmarks:bar-toggle',
  'app:menu',
  'bookmarks:item-menu',
  'downloads:list',
  'downloads:action',
  'downloads:clear',
  'permission:respond',
  'settings:get',
  'settings:set',
  'theme:set',
  'extensions:list',
  'extensions:add',
  'extensions:remove',
  'clipboard:write',
  'passwords:list',
  'passwords:add',
  'passwords:update',
  'passwords:delete',
  'passwords:reveal',
  'passwords:copy',
  'passwords:fill',
  'passwords:import',
  'passwords:export',
  'passwords:google',
  'passwords:prompt-respond',
  'module:invoke',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

/** Events pushed from main to the UI. */
export const EVENT_CHANNELS = ['state', 'command', 'downloads', 'permission', 'find-result', 'module-event', 'toast'] as const;
export type EventChannel = (typeof EVENT_CHANNELS)[number];

export interface AetherBridge {
  invoke<T = unknown>(channel: InvokeChannel, payload?: unknown): Promise<T>;
  on(channel: EventChannel, listener: (payload: any) => void): () => void;
}
