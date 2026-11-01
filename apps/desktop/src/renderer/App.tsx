import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PermissionPrompt, UiCommand, WindowState } from '../shared/types';
import { themeCss } from '../shared/themes';
import { setActiveIconSet } from './icons';
import { bridge, call, send } from './api';
import { CommandPalette } from './components/CommandPalette';
import { ContentArea } from './components/ContentArea';
import { FindBar } from './components/FindBar';
import { PermissionBar } from './components/PermissionBar';
import { ProfileMenu } from './components/ProfileMenu';
import { Sidebar, type PanelId } from './components/Sidebar';
import { BookmarksBar } from './components/BookmarksBar';
import { LoginBar } from './components/LoginBar';
import { TabStrip } from './components/TabStrip';
import { Toasts, toast } from './components/Toasts';
import { Toolbar } from './components/Toolbar';
import { WorkspaceMenu } from './components/WorkspaceMenu';

export type Popover = null | 'profile' | 'workspace' | 'palette' | 'omnibox';

export interface Snapshot {
  rect: { x: number; y: number; width: number; height: number };
  dataUrl: string;
}

const SIDEBAR_KEY = 'aether.sidebar';

function readSidebar(): PanelId | null {
  try {
    return (localStorage.getItem(SIDEBAR_KEY) as PanelId | null) || null;
  } catch {
    return null;
  }
}

export function App() {
  const [state, setState] = useState<WindowState | null>(null);
  const [popover, setPopoverRaw] = useState<Popover>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [panel, setPanelRaw] = useState<PanelId | null>(readSidebar);
  const [findOpen, setFindOpen] = useState(false);
  const [permissions, setPermissions] = useState<PermissionPrompt[]>([]);
  const [bangs, setBangs] = useState<{ trigger: string; name: string; category: string }[]>([]);
  const omniboxRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<Popover>(null);

  const setPanel = useCallback((p: PanelId | null) => {
    setPanelRaw(p);
    try {
      if (p) localStorage.setItem(SIDEBAR_KEY, p);
      else localStorage.removeItem(SIDEBAR_KEY);
    } catch {
      /* storage may be unavailable */
    }
  }, []);

  /** Popovers overlap web content, so the views are swapped for snapshots while open. */
  const setPopover = useCallback((p: Popover) => {
    const wasOpen = popoverRef.current !== null;
    popoverRef.current = p;
    setPopoverRaw(p);
    if (p && !wasOpen) {
      void call<Snapshot[]>('ui:overlay', true).then((shots) => {
        if (popoverRef.current) setSnapshots(shots);
      });
    } else if (!p && wasOpen) {
      setSnapshots([]);
      send('ui:overlay', false);
    }
  }, []);

  useEffect(() => {
    const offs = [
      bridge.on('state', (s: WindowState) => setState(s)),
      bridge.on('command', (cmd: UiCommand) => {
        switch (cmd) {
          case 'focus-address':
            omniboxRef.current?.focus();
            omniboxRef.current?.select();
            break;
          case 'find':
            setFindOpen(true);
            break;
          case 'command-palette':
            setPopover(popoverRef.current === 'palette' ? null : 'palette');
            break;
          case 'toggle-sidebar':
            setPanelRaw((cur) => {
              const next = cur ? null : 'notes';
              try {
                if (next) localStorage.setItem(SIDEBAR_KEY, next);
                else localStorage.removeItem(SIDEBAR_KEY);
              } catch {
                /* ignore */
              }
              return next;
            });
            break;
          case 'panel:history':
            setPanel('history');
            break;
          case 'panel:bookmarks':
            setPanel('bookmarks');
            break;
          case 'panel:downloads':
            setPanel('downloads');
            break;
          case 'panel:notes':
            setPanel('notes');
            break;
          case 'panel:passwords':
            setPanel('passwords');
            break;
          case 'panel:settings':
            setPanel('settings');
            break;
          case 'panel:privacy':
            setPanel('aether.protection:privacy');
            break;
          case 'escape':
            setPopover(null);
            break;
        }
      }),
      bridge.on('permission', (p: PermissionPrompt) => setPermissions((list) => [...list, p])),
      bridge.on('toast', (t: { kind: 'info' | 'error'; text: string }) => toast(t.text, t.kind)),
    ];
    void call<{ bangs: typeof bangs }>('ui:ready').then((r) => setBangs(r.bangs));
    return () => offs.forEach((off) => off());
  }, [setPanel, setPopover]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (popoverRef.current) setPopover(null);
        else if (findOpen) setFindOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findOpen, setPopover]);

  const activeTab = useMemo(() => state?.tabs.find((t) => t.id === state.activeTabId) ?? null, [state]);

  useLayoutEffect(() => {
    if (!state) return;
    const root = document.documentElement;
    root.style.cssText = themeCss(state.theme);
    root.dataset.theme = state.theme.id;
    root.dataset.mode = state.theme.mode;
    setActiveIconSet(state.theme.iconSet);
    document.documentElement.dataset.private = String(state.isPrivate);
    document.documentElement.dataset.platform = state.platform;
    if (!state.isPrivate) document.documentElement.style.setProperty('--profile', state.profile.color);
    document.documentElement.style.setProperty('--workspace', state.workspace?.color ?? 'transparent');
  }, [state]);

  if (!state) return <div className="boot" />;

  const respondPermission = (p: PermissionPrompt, allow: boolean, remember: boolean) => {
    send('permission:respond', { requestId: p.requestId, allow, remember });
    setPermissions((list) => list.filter((x) => x.requestId !== p.requestId));
  };
  const tabPermissions = permissions.filter((p) => p.tabId === state.activeTabId);

  return (
    <div className="app">
      <TabStrip state={state} onWorkspaceClick={() => setPopover(popover === 'workspace' ? null : 'workspace')} />
      <Toolbar
        state={state}
        tab={activeTab}
        omniboxRef={omniboxRef}
        bangs={bangs}
        popover={popover}
        setPopover={setPopover}
        panel={panel}
        setPanel={setPanel}
      />
      {state.bookmarksBar && !state.isPrivate && <BookmarksBar state={state} />}
      {state.loginPrompt && state.loginPrompt.tabId === state.activeTabId && <LoginBar prompt={state.loginPrompt} />}
      {findOpen && activeTab && <FindBar tabId={activeTab.id} onClose={() => setFindOpen(false)} />}
      {tabPermissions.slice(0, 1).map((p) => (
        <PermissionBar key={p.requestId} prompt={p} isPrivate={state.isPrivate} onRespond={(a, r) => respondPermission(p, a, r)} />
      ))}
      <Toasts />
      <div className="body">
        <ContentArea state={state} snapshots={snapshots} overlay={popover !== null} />
        {panel && <Sidebar state={state} panel={panel} setPanel={setPanel} />}
      </div>
      {popover === 'profile' && <ProfileMenu state={state} onClose={() => setPopover(null)} />}
      {popover === 'workspace' && <WorkspaceMenu state={state} onClose={() => setPopover(null)} />}
      {popover === 'palette' && <CommandPalette state={state} bangs={bangs} onClose={() => setPopover(null)} openPanel={(p) => setPanel(p)} />}
    </div>
  );
}
