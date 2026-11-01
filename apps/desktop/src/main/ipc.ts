import { writeFile } from 'node:fs/promises';
import { app, clipboard, dialog, ipcMain, Menu, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { DEFAULT_BANGS, quickCalc, resolveOmniboxInput, SEARCH_ENGINES } from '@aether/omnibox';
import { GROUP_COLORS, type GroupColor, type Suggestion } from '../shared/types';
import { INVOKE_CHANNELS, type InvokeChannel } from '../shared/types';
import { THEME_IDS, THEMES } from '../shared/themes';
import type { Shell } from './shell';
import { color, parse, rect, tabId, v } from './validate';
import { NEW_TAB_URL, type BrowserWindowController } from './window';

type Handler = (w: BrowserWindowController, payload: unknown, e: IpcMainInvokeEvent) => unknown;

/**
 * The only privileged IPC surface. Every call must come from the main frame
 * of a registered browser-UI WebContents loaded from the app's own origin;
 * anything else (web pages, iframes, popups) is rejected.
 */
export function registerIpc(shell: Shell): void {
  const uiOrigin = new URL(shell.uiUrl).origin;
  const uiPrefix = shell.uiUrl.startsWith('file:') ? shell.uiUrl.replace(/[^/]*$/, '') : uiOrigin;

  const senderWindow = (e: IpcMainInvokeEvent): BrowserWindowController => {
    const w = shell.fromWebContents(e.sender);
    const frame = e.senderFrame;
    if (!w || !frame || frame !== e.sender.mainFrame || !frame.url.startsWith(uiPrefix)) throw new Error('Unauthorized IPC sender');
    return w;
  };

  const tabOf = (w: BrowserWindowController, id: number) => {
    const t = w.tabs.find((x) => x.id === id);
    if (!t) throw new Error('No such tab');
    return t;
  };

  const handlers: Record<InvokeChannel, Handler> = {
    'ui:ready': (w) => {
      w.uiDidLoad();
      return { bangs: DEFAULT_BANGS.map(({ trigger, name, category }) => ({ trigger, name, category })), engines: Object.values(SEARCH_ENGINES).map(({ id, name }) => ({ id, name })) };
    },
    'ui:layout': (w, p) => w.setContentRect(parse(rect, p)),
    'ui:overlay': (w, p) => w.setOverlay(parse(v.bool(), p)),

    'tab:new': (w, p) => {
      const { url, background } = parse(v.object({ url: v.optional(v.string()), background: v.optional(v.bool()) }), p ?? {});
      return w.openTab(url ?? NEW_TAB_URL, { background, source: 'omnibox' }).id;
    },
    'tab:close': (w, p) => w.closeTab(parse(tabId, p)),
    'tab:activate': (w, p) => w.activate(parse(tabId, p)),
    'tab:navigate': (w, p) => {
      const { input, tabId: id } = parse(v.object({ input: v.string(), tabId: v.optional(tabId) }), p);
      w.navigateFromOmnibox(input, id);
    },
    'tab:back': (w, p) => tabOf(w, parse(tabId, p)).wc?.navigationHistory.goBack(),
    'tab:forward': (w, p) => tabOf(w, parse(tabId, p)).wc?.navigationHistory.goForward(),
    'tab:reload': (w, p) => w.reloadTab(tabOf(w, parse(tabId, p))),
    'tab:stop': (w, p) => tabOf(w, parse(tabId, p)).wc?.stop(),
    'tab:move': (w, p) => {
      const { tabId: id, index } = parse(v.object({ tabId, index: v.int(0, 10_000) }), p);
      w.moveTab(id, index);
    },
    'tab:pin': (w, p) => {
      const t = tabOf(w, parse(tabId, p));
      t.pinned = !t.pinned;
      if (t.pinned) t.groupId = null;
      // Pinned tabs live at the front.
      const pinnedCount = w.tabs.filter((x) => x.pinned && x !== t).length;
      w.moveTab(t.id, t.pinned ? pinnedCount : pinnedCount);
      w.changed();
    },
    'tab:mute': (w, p) => {
      const t = tabOf(w, parse(tabId, p));
      t.muted = !t.muted;
      t.wc?.setAudioMuted(t.muted);
      w.changed();
    },
    'tab:duplicate': (w, p) => {
      const t = tabOf(w, parse(tabId, p));
      w.openTab(t.url, { afterActive: true, source: 'new-tab' });
    },
    'tab:reopen-closed': (w) => w.reopenClosedTab(),
    'tab:zoom': (w, p) => {
      const { tabId: id, dir } = parse(v.object({ tabId, dir: v.int(-1, 1) }), p);
      w.zoom(tabOf(w, id), dir as -1 | 0 | 1);
    },
    'tab:find': (w, p) => {
      const { tabId: id, text, forward, findNext } = parse(v.object({ tabId, text: v.string(1000), forward: v.optional(v.bool()), findNext: v.optional(v.bool()) }), p);
      const wc = tabOf(w, id).wc;
      if (wc && text) wc.findInPage(text, { forward: forward ?? true, findNext: findNext ?? false });
    },
    'tab:stop-find': (w, p) => tabOf(w, parse(tabId, p)).wc?.stopFindInPage('keepSelection'),
    'tab:print': (w, p) => tabOf(w, parse(tabId, p)).wc?.print(),
    'tab:devtools': (w, p) => tabOf(w, parse(tabId, p)).wc?.toggleDevTools(),
    'tab:reader': (w, p) => w.toggleReader(tabOf(w, parse(tabId, p))),
    'tab:sleep': (w, p) => w.sleepTab(parse(tabId, p)),
    'tab:context-menu': (w, p) => {
      const t = tabOf(w, parse(tabId, p));
      const active = w.activeTab;
      const template: MenuItemConstructorOptions[] = [
        { label: 'New tab to the right', click: () => w.openTab(NEW_TAB_URL) },
        { label: 'Reload', click: () => w.reloadTab(t) },
        { label: 'Duplicate', click: () => w.openTab(t.url, { afterActive: true, source: 'new-tab' }) },
        { label: t.pinned ? 'Unpin' : 'Pin', click: () => handlers['tab:pin'](w, t.id, null as never) },
        { label: t.muted ? 'Unmute site' : 'Mute tab', click: () => handlers['tab:mute'](w, t.id, null as never) },
        { type: 'separator' },
        ...(t.pinned
          ? []
          : ([
              { label: 'Add tab to new group', click: () => w.createGroup([t.id]) },
              ...(w.groups.size
                ? [{ label: 'Add tab to group', submenu: [...w.groups.values()].map((g) => ({ label: g.title || `${g.color} group`, type: 'radio' as const, checked: t.groupId === g.id, click: () => w.setTabGroup(t.id, g.id) })) }]
                : []),
              ...(t.groupId ? [{ label: 'Remove from group', click: () => w.setTabGroup(t.id, null) }] : []),
              { type: 'separator' },
            ] as MenuItemConstructorOptions[])),
        { label: 'Open in split view with current tab', enabled: !!active && active.id !== t.id, click: () => active && w.setSplit(active.id, t.id) },
        { label: 'Sleep tab (free memory)', enabled: !t.sleeping && t.id !== w.activeTabId, click: () => void w.sleepTab(t.id) },
        { type: 'separator' },
        { label: 'Close', click: () => w.closeTab(t.id) },
        { label: 'Close other tabs', click: () => w.tabs.filter((x) => x !== t && !x.pinned).forEach((x) => w.closeTab(x.id)) },
        { label: 'Close tabs to the right', click: () => w.tabs.slice(w.tabs.indexOf(t) + 1).filter((x) => !x.pinned).forEach((x) => w.closeTab(x.id)) },
      ];
      Menu.buildFromTemplate(template).popup({ window: w.win });
    },

    'group:create': (w, p) => {
      const { tabIds, title, color } = parse(v.object({ tabIds: v.array(tabId, 500), title: v.optional(v.string(60)), color: v.optional(v.literal(...GROUP_COLORS)) }), p);
      return w.createGroup(tabIds, title, color as GroupColor | undefined);
    },
    'group:update': (w, p) => {
      const { id, title, color, collapsed } = parse(v.object({ id: v.string(64), title: v.optional(v.string(60)), color: v.optional(v.literal(...GROUP_COLORS)), collapsed: v.optional(v.bool()) }), p);
      w.updateGroup(id, { title, color: color as GroupColor | undefined, collapsed });
    },
    'tab:set-group': (w, p) => {
      const { tabId: id, groupId } = parse(v.object({ tabId, groupId: v.nullable(v.string(64)) }), p);
      w.setTabGroup(id, groupId);
    },
    'group:menu': (w, p) => {
      const id = parse(v.string(64), p);
      const g = w.groups.get(id);
      if (!g) return;
      const members = w.tabs.filter((t) => t.groupId === id);
      const template: MenuItemConstructorOptions[] = [
        {
          label: 'New tab in group',
          click: () => {
            const t = w.openTab(NEW_TAB_URL);
            w.setTabGroup(t.id, id);
          },
        },
        { label: g.collapsed ? 'Expand group' : 'Collapse group', click: () => w.updateGroup(id, { collapsed: !g.collapsed }) },
        { label: 'Colour', submenu: GROUP_COLORS.map((c) => ({ label: c[0].toUpperCase() + c.slice(1), type: 'radio' as const, checked: g.color === c, click: () => w.updateGroup(id, { color: c }) })) },
        { type: 'separator' },
        {
          label: 'Move group to new window',
          click: () => {
            const tabs = members.map((t) => ({ url: t.url, title: t.title, group: { id: g.id, title: g.title, color: g.color } }));
            shell.openWindow({ profileId: w.profileId, isPrivate: w.isPrivate || undefined, tabs });
            w.closeGroup(id);
          },
          enabled: !w.isPrivate,
        },
        { label: 'Ungroup', click: () => w.ungroup(id) },
        { label: `Close group (${members.length} tab${members.length === 1 ? '' : 's'})`, click: () => w.closeGroup(id) },
      ];
      Menu.buildFromTemplate(template).popup({ window: w.win });
    },
    'split:set': (w, p) => {
      const { left, right, ratio } = parse(v.object({ left: tabId, right: tabId, ratio: v.optional(v.number(0, 1)) }), p);
      w.setSplit(left, right, ratio);
    },
    'split:toggle': (w) => w.splitActive(),
    'split:ratio': (w, p) => w.setSplitRatio(parse(v.number(0, 1), p)),
    'split:close': (w) => w.closeSplit(),

    'omnibox:suggest': (w, p) => {
      const input = parse(v.string(2000), p).trim();
      if (!input) return [];
      const out: Suggestion[] = [];
      const calc = quickCalc(input);
      if (calc && 'text' in calc) out.push({ kind: 'calc', title: `= ${calc.text}`, url: '', copy: calc.copy, detail: 'Enter copies the result' });
      else if (calc) out.push({ kind: 'calc', title: calc.error, url: '', detail: 'Calculator' });
      if (input.startsWith('=')) return out;
      const engine = shell.store.getProfile(w.profileId)?.searchEngine ?? 'google';
      const r = resolveOmniboxInput(input, { engine });
      if (r.kind === 'bang') out.push({ kind: 'bang', title: r.query ? `${DEFAULT_BANGS.find((b) => b.trigger === r.bang)?.name}: ${r.query}` : `Open ${DEFAULT_BANGS.find((b) => b.trigger === r.bang)?.name}`, url: r.url });
      else if (r.kind === 'url') out.push({ kind: 'url', title: r.url, url: r.url });
      else if (r.kind === 'search') out.push({ kind: 'search', title: input, url: r.url, detail: `${SEARCH_ENGINES[engine]?.name ?? 'Search'}` });
      const lower = input.toLowerCase();
      for (const t of w.tabs) {
        if (t.id !== w.activeTabId && (t.title.toLowerCase().includes(lower) || t.url.toLowerCase().includes(lower)) && out.length < 4) out.push({ kind: 'tab', title: t.title || t.url, url: t.url, tabId: t.id, detail: 'Switch to tab' });
      }
      if (!w.isPrivate) {
        const seen = new Set(out.map((s) => s.url));
        for (const b of shell.store.allBookmarks(w.profileId)) {
          if (b.url && !seen.has(b.url) && (b.title.toLowerCase().includes(lower) || b.url.toLowerCase().includes(lower))) {
            out.push({ kind: 'bookmark', title: b.title, url: b.url });
            seen.add(b.url);
            if (out.length >= 5) break;
          }
        }
        for (const h of shell.store.suggest(w.profileId, input, 6)) {
          if (seen.has(h.url)) continue;
          out.push({ kind: 'history', title: h.title || h.url, url: h.url });
          seen.add(h.url);
        }
      } else {
        // Bangs are still useful in private windows; history is not consulted.
      }
      if (input.startsWith('!') && !input.includes(' ')) {
        const prefix = input.slice(1).toLowerCase();
        for (const b of DEFAULT_BANGS.filter((x) => x.trigger.startsWith(prefix)).slice(0, 6)) out.push({ kind: 'bang', title: `!${b.trigger}  ${b.name}`, url: b.home, detail: b.category });
      }
      return out.slice(0, 9);
    },

    'window:new': (w, p) => {
      const { profileId } = parse(v.object({ profileId: v.optional(v.string(64)) }), p ?? {});
      shell.openWindow({ profileId: profileId && shell.store.getProfile(profileId) ? profileId : w.profileId });
    },
    'window:new-private': (w) => {
      shell.openWindow({ profileId: w.profileId, isPrivate: true });
    },
    'window:close': (w) => w.win.close(),
    'window:saved-list': (w) =>
      shell.store
        .listWindowSessions(w.profileId, 'saved')
        .map((s) => ({ id: s.id, title: s.title, tabCount: s.tabs.length, updatedAt: s.updatedAt, workspaceName: s.workspaceId ? (shell.store.getWorkspace(s.workspaceId)?.name ?? null) : null })),
    'window:open-saved': (w, p) => {
      const id = parse(v.string(64), p);
      const s = shell.store.getWindowSession(id);
      if (!s || s.profileId !== w.profileId) throw new Error('Saved window not found');
      shell.restoreSession(id);
    },
    'window:delete-saved': (w, p) => {
      const id = parse(v.string(64), p);
      const s = shell.store.getWindowSession(id);
      if (s && s.profileId === w.profileId && s.state === 'saved') shell.store.deleteWindowSession(id);
      shell.broadcastState();
    },

    'profile:create': (_w, p) => {
      const { name, color: c, openWindow } = parse(v.object({ name: v.string(64), color: v.optional(color), openWindow: v.optional(v.bool()) }), p);
      const profile = shell.store.createProfile({ name, color: c });
      if (openWindow !== false) shell.openProfile(profile.id);
      shell.broadcastState();
      return profile.id;
    },
    'profile:update': (_w, p) => {
      const parsed = parse(
        v.object({
          id: v.string(64),
          name: v.optional(v.string(64)),
          color: v.optional(color),
          searchEngine: v.optional(v.literal(...(Object.keys(SEARCH_ENGINES) as [string, ...string[]]))),
          closeBehavior: v.optional(v.literal('ask', 'save', 'discard')),
          restoreOnStartup: v.optional(v.bool()),
          askDownloadLocation: v.optional(v.bool()),
        }),
        p,
      );
      const { id, ...patch } = parsed;
      shell.store.updateProfile(id, patch);
      shell.broadcastState();
    },
    'profile:open': (_w, p) => {
      const id = parse(v.string(64), p);
      if (!shell.store.getProfile(id)) throw new Error('No such profile');
      shell.openProfile(id);
    },
    'profile:delete': (w, p) => shell.deleteProfile(parse(v.string(64), p), w),
    'profile:export': async (w, p) => {
      const id = parse(v.string(64), p);
      const data = shell.store.exportProfile(id);
      if (!data) throw new Error('No such profile');
      const name = shell.store.getProfile(id)!.name.replace(/[^\w-]+/g, '_');
      const { filePath, canceled } = await dialog.showSaveDialog(w.win, { defaultPath: `aether-profile-${name}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (canceled || !filePath) return false;
      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
      return true;
    },

    'workspace:create-from-window': (w, p) => {
      if (w.isPrivate) throw new Error('Workspaces are not available in private windows');
      const { name, color: c, empty } = parse(v.object({ name: v.string(80), color: v.optional(color), empty: v.optional(v.bool()) }), p);
      const snap = w.snapshot('open');
      const ws = shell.store.createWorkspace(w.profileId, { name, color: c, tabs: empty ? [] : snap.tabs, activeIndex: empty ? 0 : snap.activeIndex });
      if (empty) void w.switchWorkspace(ws.id);
      else {
        w.workspaceId = ws.id;
        w.persistNow();
      }
      shell.broadcastState();
      return ws.id;
    },
    'workspace:switch': async (w, p) => {
      const id = parse(v.nullable(v.string(64)), p);
      if (id) {
        const other = [...shell.windows.values()].find((x) => x !== w && x.workspaceId === id);
        if (other) {
          other.win.focus();
          return;
        }
      }
      await w.switchWorkspace(id);
      shell.broadcastState();
    },
    'workspace:open-in-new-window': (w, p) => {
      const id = parse(v.string(64), p);
      const ws = shell.store.getWorkspace(id);
      if (!ws || ws.profileId !== w.profileId) throw new Error('Workspace not found');
      const other = [...shell.windows.values()].find((x) => x.workspaceId === id);
      if (other) return other.win.focus();
      shell.openWindow({ profileId: w.profileId, workspaceId: id, tabs: ws.tabs, activeIndex: ws.activeIndex });
      shell.broadcastState();
    },
    'workspace:detach': (w) => {
      w.workspaceId = null;
      w.persistNow();
      shell.broadcastState();
    },
    'workspace:rename': (w, p) => {
      const { id, name, color: c } = parse(v.object({ id: v.string(64), name: v.optional(v.string(80)), color: v.optional(color) }), p);
      const ws = shell.store.getWorkspace(id);
      if (!ws || ws.profileId !== w.profileId) throw new Error('Workspace not found');
      shell.store.updateWorkspace(id, { name, color: c });
      shell.broadcastState();
    },
    'workspace:delete': async (w, p) => {
      const id = parse(v.string(64), p);
      const ws = shell.store.getWorkspace(id);
      if (!ws || ws.profileId !== w.profileId) throw new Error('Workspace not found');
      const { response } = await dialog.showMessageBox(w.win, {
        type: 'warning',
        message: `Delete workspace “${ws.name}”?`,
        detail: `Its ${ws.tabs.length} saved tabs and notes are removed. Windows showing it stay open as ordinary windows.`,
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) return false;
      for (const x of shell.windows.values()) if (x.workspaceId === id) x.workspaceId = null;
      shell.store.deleteWorkspace(id);
      shell.broadcastState();
      return true;
    },
    'workspace:get-notes': (w, p) => {
      const id = parse(v.nullable(v.string(64)), p);
      if (!id) return shell.store.getSetting<string>(`inbox:${w.profileId}`, '');
      const ws = shell.store.getWorkspace(id);
      if (!ws || ws.profileId !== w.profileId) throw new Error('Workspace not found');
      return ws.notes;
    },
    'workspace:set-notes': (w, p) => {
      const { id, notes } = parse(v.object({ id: v.nullable(v.string(64)), notes: v.string(200_000) }), p);
      if (w.isPrivate) throw new Error('Notes are not saved in private windows');
      if (!id) return shell.store.setSetting(`inbox:${w.profileId}`, notes);
      const ws = shell.store.getWorkspace(id);
      if (!ws || ws.profileId !== w.profileId) throw new Error('Workspace not found');
      shell.store.updateWorkspace(id, { notes });
    },

    'history:list': (w, p) => {
      if (w.isPrivate) return [];
      const { query, before } = parse(v.object({ query: v.optional(v.string(500)), before: v.optional(v.number(0)) }), p ?? {});
      return shell.store.listHistory(w.profileId, { query, before, limit: 200 });
    },
    'history:delete': (w, p) => shell.store.deleteHistoryEntry(w.profileId, parse(v.int(0), p)),
    'history:clear': async (w, p) => {
      const range = parse(v.literal('hour', 'day', 'week', 'all'), p);
      const since = range === 'all' ? undefined : Date.now() - { hour: 3_600_000, day: 86_400_000, week: 604_800_000 }[range];
      shell.store.clearHistory(w.profileId, since);
      if (range === 'all') await w.session.clearCache();
    },

    'bookmarks:list': (w) => (w.isPrivate ? shell.store.allBookmarks(w.profileId) : shell.store.allBookmarks(w.profileId)),
    'bookmarks:toggle': (w) => {
      const t = w.activeTab;
      if (!t || w.isPrivate) return false;
      return shell.toggleBookmark(w, t);
    },
    'bookmarks:add': (w, p) => {
      const { title, url, parentId } = parse(v.object({ title: v.string(1024), url: v.nullable(v.string()), parentId: v.optional(v.nullable(v.int(0))) }), p);
      if (url && !/^(https?|aether|file):/i.test(url)) throw new Error('Unsupported bookmark URL');
      const b = shell.store.addBookmark(w.profileId, { title, url, parentId });
      shell.bookmarksChanged();
      return b;
    },
    'bookmarks:update': (w, p) => {
      const { id, title, url } = parse(v.object({ id: v.int(0), title: v.optional(v.string(1024)), url: v.optional(v.string()) }), p);
      if (url && !/^(https?|aether|file):/i.test(url)) throw new Error('Unsupported bookmark URL');
      shell.store.updateBookmark(w.profileId, id, { title, url });
      shell.bookmarksChanged();
    },
    'bookmarks:delete': (w, p) => {
      shell.store.deleteBookmark(w.profileId, parse(v.int(0), p));
      shell.bookmarksChanged();
    },

    'bookmarks:bar-toggle': () => shell.toggleBookmarksBar(),
    'bookmarks:item-menu': (w, p) => {
      const { id, x, y, context } = parse(v.object({ id: v.int(0), x: v.int(0, 100_000), y: v.int(0, 100_000), context: v.optional(v.bool()) }), p);
      const all = shell.store.allBookmarks(w.profileId);
      const item = all.find((b) => b.id === id);
      if (!item) return;
      const open = (url: string, background = false) => (background ? w.openTab(url, { background: true, source: 'omnibox' }) : w.navigateFromOmnibox(url));
      const folderItems = (parentId: number): MenuItemConstructorOptions[] => {
        const kids = all.filter((b) => b.parentId === parentId);
        if (!kids.length) return [{ label: '(empty)', enabled: false }];
        const items: MenuItemConstructorOptions[] = kids.map((b) =>
          b.url ? { label: b.title.slice(0, 80) || b.url, click: () => open(b.url!) } : { label: b.title.slice(0, 80), submenu: folderItems(b.id) },
        );
        const urls = kids.filter((b) => b.url).map((b) => b.url!);
        if (urls.length > 1) items.push({ type: 'separator' }, { label: `Open all (${urls.length})`, click: () => urls.forEach((u) => w.openTab(u, { background: true, source: 'omnibox' })) });
        return items;
      };
      const remove: MenuItemConstructorOptions = {
        label: item.url ? 'Delete' : 'Delete folder',
        click: () => {
          shell.store.deleteBookmark(w.profileId, id);
          shell.bookmarksChanged();
        },
      };
      const template: MenuItemConstructorOptions[] =
        item.url && context
          ? [{ label: 'Open', click: () => open(item.url!) }, { label: 'Open in new tab', click: () => open(item.url!, true) }, { label: 'Open in new window', click: () => shell.openWindow({ profileId: w.profileId, tabs: [{ url: item.url!, title: item.title }] }) }, { type: 'separator' }, remove]
          : item.url
            ? []
            : context
              ? [...folderItems(id), { type: 'separator' }, remove]
              : folderItems(id);
      if (template.length) Menu.buildFromTemplate(template).popup({ window: w.win, x, y });
    },

    // The browser's main menu (the "⋮" button), also opened on its theme section by the palette button.
    'app:menu': (w, p) => {
      const { x, y, section } = parse(v.object({ x: v.int(0, 100_000), y: v.int(0, 100_000), section: v.optional(v.literal('theme')) }), p);
      const tab = w.activeTab;
      const current = shell.themeId();
      const themes: MenuItemConstructorOptions[] = [
        ...Object.values(THEMES).map((t): MenuItemConstructorOptions => ({ label: t.name, type: 'radio', checked: current === t.id, click: () => shell.setTheme(t.id) })),
        { type: 'separator' },
        { label: 'Match Windows (light or dark)', type: 'radio', checked: current === 'system', click: () => shell.setTheme('system') },
      ];
      if (section === 'theme') return void Menu.buildFromTemplate(themes).popup({ window: w.win, x, y });
      const web = !!tab && /^https?:/i.test(tab.url);
      const template: MenuItemConstructorOptions[] = [
        { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => w.openTab(NEW_TAB_URL, { source: 'omnibox' }) },
        { label: 'New window', accelerator: 'CmdOrCtrl+N', click: () => shell.openWindow({ profileId: w.profileId }) },
        { label: 'New private window', accelerator: 'CmdOrCtrl+Shift+N', click: () => shell.openWindow({ profileId: w.profileId, isPrivate: true }) },
        { type: 'separator' },
        { label: 'History', accelerator: 'CmdOrCtrl+H', click: () => w.command('panel:history') },
        { label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: () => w.command('panel:downloads') },
        {
          label: 'Bookmarks',
          submenu: [
            { label: 'Bookmark this page', accelerator: 'CmdOrCtrl+D', enabled: web, click: () => tab && shell.toggleBookmark(w, tab) },
            { label: 'Show bookmarks bar', type: 'checkbox', checked: shell.bookmarksBarVisible(), accelerator: 'CmdOrCtrl+Shift+B', click: () => shell.toggleBookmarksBar() },
            { label: 'All bookmarks', click: () => w.command('panel:bookmarks') },
          ],
        },
        { label: 'Passwords', accelerator: 'CmdOrCtrl+Shift+L', click: () => w.command('panel:passwords') },
        { label: 'Ad blocking and privacy', click: () => w.command('panel:privacy') },
        { type: 'separator' },
        {
          label: 'Zoom',
          enabled: !!tab,
          submenu: [
            { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => tab && w.zoom(tab, 1) },
            { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => tab && w.zoom(tab, -1) },
            { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => tab && w.zoom(tab, 0) },
          ],
        },
        { label: 'Find on page', accelerator: 'CmdOrCtrl+F', enabled: !!tab, click: () => w.command('find') },
        { label: 'Reader view', accelerator: 'CmdOrCtrl+Alt+R', enabled: web, click: () => tab && void w.toggleReader(tab).catch(() => undefined) },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', enabled: !!tab, click: () => tab?.wc?.print() },
        { type: 'separator' },
        { label: 'Theme', submenu: themes },
        { label: 'Settings', click: () => w.command('panel:settings') },
        { label: `About AETHER ${app.getVersion()}`, enabled: false },
        { type: 'separator' },
        { label: 'Exit', click: () => app.quit() },
      ];
      Menu.buildFromTemplate(template).popup({ window: w.win, x, y });
    },

    'downloads:list': (w) => shell.downloads.list({ profileId: w.profileId, isPrivate: w.isPrivate, partition: w.partition() }),
    'downloads:action': (w, p) => {
      const { id, action } = parse(v.object({ id: v.int(), action: v.literal('open', 'show', 'cancel', 'pause', 'resume', 'remove') }), p);
      shell.downloads.action(id, action, { profileId: w.profileId, isPrivate: w.isPrivate, partition: w.partition() });
    },
    'downloads:clear': (w) => {
      if (!w.isPrivate) shell.store.clearDownloads(w.profileId);
      return shell.downloads.list({ profileId: w.profileId, isPrivate: w.isPrivate, partition: w.partition() });
    },

    'permission:respond': (_w, p) => {
      const { requestId, allow, remember } = parse(v.object({ requestId: v.int(1), allow: v.bool(), remember: v.bool() }), p);
      shell.respondPermission(requestId, allow, remember);
    },

    'settings:get': (w) => ({
      sleepAfterMinutes: shell.sleepAfterMinutes(),
      permissions: w.isPrivate ? [] : shell.store.listPermissions(w.profileId),
    }),
    'settings:set': (w, p) => {
      const { sleepAfterMinutes, clearPermission } = parse(
        v.object({ sleepAfterMinutes: v.optional(v.int(0, 24 * 60)), clearPermission: v.optional(v.object({ origin: v.string(2048), permission: v.string(64) })) }),
        p,
      );
      if (sleepAfterMinutes !== undefined) shell.store.setSetting('sleepAfterMinutes', sleepAfterMinutes);
      if (clearPermission) shell.store.setPermission(w.profileId, clearPermission.origin, clearPermission.permission, null);
      shell.broadcastState();
    },

    'clipboard:write': (_w, p) => clipboard.writeText(parse(v.string(10_000), p)),
    'extensions:list': (w) => (w.isPrivate ? [] : shell.extensions.list(w.session)),
    'extensions:add': async (w) => {
      if (w.isPrivate) throw new Error('Extensions are not available in private windows');
      const r = await dialog.showOpenDialog(w.win, { title: 'Choose an unpacked extension folder (with manifest.json)', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return null;
      return shell.extensions.add(w.session, w.profileId, r.filePaths[0]);
    },
    'extensions:remove': (w, p) => shell.extensions.remove(w.session, w.profileId, parse(v.string(64), p)),
    'theme:set': (_w, p) => shell.setTheme(parse(v.literal(...(THEME_IDS as unknown as [string, ...string[]])), p)),

    'passwords:list': (w, p) => shell.passwords.list(w, parse(v.optional(v.string(200)), p)),
    'passwords:add': (w, p) => shell.passwords.add(w, parse(v.object({ url: v.string(2048), username: v.string(1024), password: v.string(4096), note: v.optional(v.string(4000)) }), p)),
    'passwords:update': (w, p) => {
      const { id, ...patch } = parse(v.object({ id: v.int(1), username: v.optional(v.string(1024)), password: v.optional(v.string(4096)), note: v.optional(v.string(4000)) }), p);
      shell.passwords.update(w, id, patch);
    },
    'passwords:delete': (w, p) => shell.passwords.delete(w, parse(v.int(1), p)),
    'passwords:reveal': (w, p) => shell.passwords.reveal(w, parse(v.int(1), p)),
    'passwords:copy': (w, p) => {
      const { id, field } = parse(v.object({ id: v.int(1), field: v.literal('password', 'username') }), p);
      shell.passwords.copy(w, id, field as 'password' | 'username');
    },
    'passwords:fill': (w, p) => shell.passwords.fill(w, parse(v.int(1), p)),
    'passwords:import': (w) => shell.passwords.importFromFile(w),
    'passwords:export': (w) => shell.passwords.exportToFile(w),
    'passwords:prompt-respond': (w, p) => shell.passwords.respondToOffer(w, parse(v.literal('save', 'never', 'dismiss'), p) as 'save' | 'never' | 'dismiss'),
    'passwords:google': (w) => shell.passwords.openGoogleExport(w),

    'module:invoke': (w, p) => {
      const { moduleId, method, payload } = parse(v.object({ moduleId: v.string(32), method: v.string(64), payload: v.any() }), p);
      return shell.modules.invoke(moduleId, method, payload, { windowId: w.id, profileId: w.profileId, isPrivate: w.isPrivate });
    },
  };

  // Content hook (web frames). Only web sessions are served; the frame URL comes from
  // the browser process, never from the page, and replies hold only filter data.
  const frameRequest = (e: Electron.IpcMainEvent | IpcMainInvokeEvent, dom?: unknown) => {
    const ctx = shell.sessions.context(e.sender.session);
    const frame = e.senderFrame;
    if (!ctx || !frame || frame !== e.sender.mainFrame) return null;
    const list = v.optional(v.array(v.string(500), 2000));
    const parsedDom = dom === undefined ? undefined : parse(v.object({ classes: list, ids: list, hrefs: list }), dom);
    return shell.modules.frameStart({
      url: frame.url,
      topLevelUrl: e.sender.getURL(),
      isMainFrame: true,
      profileId: ctx.profileId,
      partition: ctx.partition,
      isPrivate: ctx.isPrivate,
      dom: parsedDom && { classes: parsedDom.classes ?? [], ids: parsedDom.ids ?? [], hrefs: parsedDom.hrefs ?? [] },
    });
  };
  ipcMain.on('aether:frame-start', (e) => {
    try {
      e.returnValue = frameRequest(e);
    } catch {
      e.returnValue = null;
    }
  });
  ipcMain.on('aether:login-submit', (e, payload) => {
    try {
      const entry = shell.tabByWebContents(e.sender.id);
      if (!entry || e.senderFrame !== e.sender.mainFrame) return;
      const { username, password } = parse(v.object({ username: v.string(1024), password: v.string(4096) }), payload);
      shell.passwords.offerFromSubmit(entry.win, entry.tab.id, e.sender.getURL(), username, password);
    } catch {
      /* ignore malformed reports */
    }
  });
  ipcMain.handle('aether:frame-dom', (e, dom) => frameRequest(e, dom ?? {}));

  for (const channel of INVOKE_CHANNELS) {
    const handler = handlers[channel];
    ipcMain.handle(channel, async (e, payload) => {
      const w = senderWindow(e);
      return handler(w, payload, e);
    });
  }
}
