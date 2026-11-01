import { createElement, Fragment, useMemo, type ComponentType } from 'react';
import type { PanelApi, SidebarPanelDefinition } from '@aether/plugin-api';
import type { WindowState } from '../../shared/types';
import { bridge, call, send } from '../api';
import { RENDERER_MODULES } from '../modules';
import { BookmarksPanel } from '../panels/BookmarksPanel';
import { PasswordsPanel } from '../panels/PasswordsPanel';
import { DownloadsPanel } from '../panels/DownloadsPanel';
import { HistoryPanel } from '../panels/HistoryPanel';
import { NotesPanel } from '../panels/NotesPanel';
import { SettingsPanel } from '../panels/SettingsPanel';
import { ErrorBoundary } from './ErrorBoundary';
import { Icon, useHasIcon } from './Icon';

export type PanelId = string;

const CORE: { id: string; title: string; icon: string }[] = [
  { id: 'notes', title: 'Notes', icon: 'notes' },
  { id: 'bookmarks', title: 'Bookmarks', icon: 'bookmark' },
  { id: 'history', title: 'History', icon: 'history' },
  { id: 'downloads', title: 'Downloads', icon: 'download' },
  { id: 'passwords', title: 'Passwords', icon: 'key' },
];

const modulePanels: (SidebarPanelDefinition & { moduleId: string })[] = RENDERER_MODULES.flatMap((m) => (m.panels ?? []).map((p) => ({ ...p, moduleId: m.id })));

export function Sidebar({ state, panel, setPanel }: { state: WindowState; panel: PanelId; setPanel: (p: PanelId | null) => void }) {
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  const mod = modulePanels.find((p) => `${p.moduleId}:${p.id}` === panel);
  const width = mod?.width ?? 340;

  const api = useMemo<PanelApi | null>(() => {
    if (!mod) return null;
    return {
      invoke: (method, payload) => call('module:invoke', { moduleId: mod.moduleId, method, payload }) as never,
      on: (event, listener) =>
        bridge.on('module-event', (e: { event: string; payload: unknown }) => {
          if (e.event === `${mod.moduleId}:${event}`) listener(e.payload);
        }),
      openUrl: (url) => send('tab:new', { url }),
      activeTab: { tabId: active?.id ?? null, url: active?.url ?? '', title: active?.title ?? '', profileId: state.profile.id, workspaceId: state.workspace?.id ?? null, isPrivate: state.isPrivate },
    };
  }, [mod, active?.id, active?.url, active?.title, state.profile.id, state.workspace?.id, state.isPrivate]);

  const title = mod?.title ?? CORE.find((c) => c.id === panel)?.title ?? (panel === 'settings' ? 'Settings' : '');

  return (
    <aside className="sidebar" style={{ width }}>
      <nav className="rail">
        {CORE.map((c) => (
          <button key={c.id} className={`rail-btn ${panel === c.id ? 'on' : ''}`} title={c.title} aria-label={c.title} onClick={() => setPanel(c.id)}>
            <Icon name={c.icon} />
          </button>
        ))}
        {modulePanels.map((p, i) => (
          <Fragment key={`${p.moduleId}:${p.id}`}>
            {(i === 0 || modulePanels[i - 1].moduleId !== p.moduleId) && <span className="rail-sep" />}
            <button className={`rail-btn ${panel === `${p.moduleId}:${p.id}` ? 'on' : ''}`} title={p.title} aria-label={p.title} onClick={() => setPanel(`${p.moduleId}:${p.id}`)}>
              <RailGlyph id={p.id} glyph={p.icon} />
            </button>
          </Fragment>
        ))}
        <span className="grow" />
        <button className={`rail-btn ${panel === 'settings' ? 'on' : ''}`} title="Settings (themes, search, privacy)" aria-label="Settings" onClick={() => setPanel('settings')}>
          <Icon name="settings" />
        </button>
      </nav>
      <section className="panel">
        <header className="panel-head">
          <h3>{title}</h3>
          <button className="icon-btn small" title="Close sidebar (Ctrl+B)" onClick={() => setPanel(null)}>
            <Icon name="close" size={14} />
          </button>
        </header>
        <div className="panel-body">
          <ErrorBoundary label={title || 'Panel'} key={panel}>
            {panel === 'notes' && <NotesPanel state={state} />}
            {panel === 'bookmarks' && <BookmarksPanel state={state} />}
            {panel === 'history' && <HistoryPanel state={state} />}
            {panel === 'downloads' && <DownloadsPanel />}
            {panel === 'passwords' && <PasswordsPanel state={state} />}
            {panel === 'settings' && <SettingsPanel state={state} />}
            {mod && api && createElement(mod.component as ComponentType<{ api: PanelApi }>, { api })}
            {!mod && !CORE.some((c) => c.id === panel) && panel !== 'settings' && <p className="muted">This panel is not available.</p>}
          </ErrorBoundary>
        </div>
      </section>
    </aside>
  );
}

/** Module panels bring a text glyph; an icon set can replace it with a `panel:<id>` icon. */
function RailGlyph({ id, glyph }: { id: string; glyph: string }) {
  const themed = useHasIcon(`panel:${id}`);
  return themed ? <Icon name={`panel:${id}`} /> : <span className="rail-glyph">{glyph}</span>;
}
