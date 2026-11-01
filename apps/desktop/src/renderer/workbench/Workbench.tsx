import { useMemo } from 'react';
import type { WorkbenchAppApi } from '@aether/plugin-api';
import type { WindowState } from '../../shared/types';
import { bridge, call, send } from '../api';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { APPS, getApp, type AppDef } from './apps';
import { addonInstalled, useAddons, useWorkbench, workbench } from './store';
import './workbench.css';

function download(name: string, data: Blob | string, mime = 'application/octet-stream') {
  const blob = typeof data === 'string' ? new Blob([data], { type: `${mime};charset=utf-8` }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function useAppApi(app: AppDef, state: WindowState, arg: string | undefined): WorkbenchAppApi {
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  return useMemo<WorkbenchAppApi>(
    () => ({
      invoke: (method, payload) => call('module:invoke', { moduleId: app.moduleId, method, payload }) as never,
      invokeModule: (moduleId, method, payload) => call('module:invoke', { moduleId, method, payload }) as never,
      on: (event, listener) =>
        bridge.on('module-event', (e: { event: string; payload: unknown }) => {
          if (e.event === `${app.moduleId}:${event}`) listener(e.payload);
        }),
      openUrl: (url) => {
        send('tab:new', { url });
        if (workbench.get().mode === 'full') workbench.show(false);
      },
      download,
      openApp: (id, a) => workbench.open(id, a),
      arg,
      activeTab: { tabId: active?.id ?? null, url: active?.url ?? '', title: active?.title ?? '', profileId: state.profile.id, workspaceId: state.workspace?.id ?? null, isPrivate: state.isPrivate },
    }),
    [app.moduleId, arg, active?.id, active?.url, active?.title, state.profile.id, state.workspace?.id, state.isPrivate],
  );
}

function AppHost({ app, state, arg, hidden }: { app: AppDef; state: WindowState; arg?: string; hidden: boolean }) {
  const api = useAppApi(app, state, arg);
  const C = app.component;
  return (
    <div className="wb-app" hidden={hidden}>
      <ErrorBoundary label={app.title}>
        <C api={api} />
      </ErrorBoundary>
    </div>
  );
}

/** The Workbench: full-size apps that cover the web page, or sit beside it in split mode. */
export function Workbench({ state }: { state: WindowState }) {
  const wb = useWorkbench();
  const addons = useAddons();
  const opened = wb.opened.filter((o) => {
    const a = getApp(o.id);
    return a && addonInstalled(addons, a.addon);
  });
  const showLauncher = !wb.active || !opened.some((o) => o.id === wb.active);
  return (
    <section className={`workbench ${wb.mode}`} style={wb.mode === 'split' ? { flexBasis: `${(1 - wb.ratio) * 100}%` } : undefined}>
      {wb.mode === 'split' && <SplitHandle />}
      <header className="wb-bar">
        <button className={`wb-tab home ${showLauncher ? 'on' : ''}`} title="All apps" onClick={() => workbench.activate('')}>
          ▦
        </button>
        {opened.map((o) => {
          const a = getApp(o.id)!;
          return (
            <div key={o.id} className={`wb-tab ${wb.active === o.id ? 'on' : ''}`} onClick={() => workbench.activate(o.id)} role="tab" aria-selected={wb.active === o.id}>
              <span>{a.icon}</span>
              <span className="ellipsis">{a.title}</span>
              <button
                className="wb-tab-x"
                title="Close app"
                onClick={(e) => {
                  e.stopPropagation();
                  workbench.closeApp(o.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        <span className="grow" />
        <div className="wb-seg" role="group" aria-label="Layout">
          <button className={wb.mode === 'split' ? 'on' : ''} title="Beside the page (read and work side by side)" onClick={() => workbench.setMode('split')}>
            ◧ Split
          </button>
          <button className={wb.mode === 'full' ? 'on' : ''} title="Cover the page" onClick={() => workbench.setMode('full')}>
            ▣ Full
          </button>
        </div>
        <button className="wb-btn" title="Back to the web (Ctrl+Shift+Space)" onClick={() => workbench.show(false)}>
          Back to web
        </button>
      </header>
      <div className="wb-body">
        {showLauncher && <Launcher />}
        {opened.map((o) => (
          <AppHost key={`${o.id}`} app={getApp(o.id)!} state={state} arg={o.arg} hidden={wb.active !== o.id} />
        ))}
      </div>
    </section>
  );
}

function SplitHandle() {
  return (
    <div
      className="wb-split"
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e) => {
        const parent = (e.currentTarget.parentElement!.parentElement as HTMLElement).getBoundingClientRect();
        const t = e.currentTarget;
        t.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => workbench.setRatio((ev.clientX - parent.left) / parent.width);
        const up = () => {
          t.removeEventListener('pointermove', move);
          t.removeEventListener('pointerup', up);
        };
        t.addEventListener('pointermove', move);
        t.addEventListener('pointerup', up);
      }}
    />
  );
}

export function Launcher() {
  const addons = useAddons();
  const core = APPS.filter((a) => !a.addon && a.id !== 'store');
  const packs = APPS.filter((a) => a.addon && addonInstalled(addons, a.addon));
  const missing = (addons?.status ?? []).filter((p) => !p.installed);
  return (
    <div className="wb-launcher">
      <h2>Workbench</h2>
      <p className="muted">Apps that live next to your tabs. Open one in Split to read a page and work beside it.</p>
      <h4>Built in</h4>
      <div className="wb-grid">
        {core.map((a) => (
          <AppTile key={a.id} app={a} />
        ))}
      </div>
      {!!packs.length && (
        <>
          <h4>From your modules</h4>
          <div className="wb-grid">
            {packs.map((a) => (
              <AppTile key={a.id} app={a} />
            ))}
          </div>
        </>
      )}
      <h4>Modules</h4>
      {addons?.safeMode && <p className="wb-note">Safe mode: every module is off for this session. Restart AETHER normally to turn them back on.</p>}
      <div className="wb-grid">
        <AppTile app={getApp('store')!} badge={missing.length ? `${missing.length} available` : undefined} />
      </div>
    </div>
  );
}

function AppTile({ app, badge }: { app: AppDef; badge?: string }) {
  return (
    <button className="wb-tile" onClick={() => workbench.open(app.id)}>
      <span className="wb-tile-icon">{app.icon}</span>
      <b>{app.title}</b>
      <small className="muted">{app.description}</small>
      {badge && <span className="wb-badge">{badge}</span>}
    </button>
  );
}
