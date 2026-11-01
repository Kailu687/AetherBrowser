import { Fragment, useState } from 'react';
import type { TabGroup, TabState, WindowState } from '../../shared/types';
import { send } from '../api';
import { Icon } from './Icon';

function Favicon({ tab }: { tab: TabState }) {
  if (tab.loading) return <span className="spinner" aria-label="Loading" />;
  if (tab.crashed) return <span className="fav-fallback warn">!</span>;
  if (tab.favicon) return <img className="favicon" src={tab.favicon} alt="" draggable={false} />;
  const letter = (() => {
    try {
      const u = new URL(tab.url);
      if (u.protocol === 'aether:') return '✦';
      return u.hostname.replace(/^www\./, '')[0]?.toUpperCase() ?? '•';
    } catch {
      return '•';
    }
  })();
  return <span className="fav-fallback">{letter}</span>;
}

function GroupChip({ group, count, onDropTab }: { group: TabGroup; count: number; onDropTab: () => void }) {
  const [editing, setEditing] = useState(group.title === '' && count === 1 && !group.collapsed);
  const [value, setValue] = useState(group.title);
  const save = () => {
    setEditing(false);
    if (value !== group.title) send('group:update', { id: group.id, title: value.trim() });
  };
  return (
    <div
      className={`group-chip gc-${group.color} ${group.collapsed ? 'collapsed' : ''}`}
      title={`${group.title || 'Unnamed group'}: ${count} tab${count === 1 ? '' : 's'}. Click to ${group.collapsed ? 'expand' : 'collapse'}, double-click to rename.`}
      onClick={() => !editing && send('group:update', { id: group.id, collapsed: !group.collapsed })}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setValue(group.title);
        setEditing(true);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        send('group:menu', group.id);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropTab();
      }}
    >
      {editing ? (
        <input
          className="group-input"
          autoFocus
          value={value}
          maxLength={60}
          placeholder="Name this group"
          onChange={(e) => setValue(e.target.value)}
          onBlur={save}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <span className="group-title">{group.title || (group.collapsed ? String(count) : '')}</span>
      )}
      {group.collapsed && group.title && <span className="group-count">{count}</span>}
    </div>
  );
}

export function TabStrip({ state, onWorkspaceClick }: { state: WindowState; onWorkspaceClick: () => void }) {
  const [dragId, setDragId] = useState<number | null>(null);
  const split = state.split;
  return (
    <div className="titlebar">
      <button className={`workspace-chip ${state.workspace ? 'bound' : ''}`} onClick={onWorkspaceClick} title="Workspaces: switch research context without losing anything">
        {state.isPrivate ? (
          <>
            <Icon name="mask" /> <span>Private</span>
          </>
        ) : (
          <>
            <span className="ws-dot" style={{ background: state.workspace?.color ?? 'var(--muted)' }} />
            <span className="ws-name">{state.workspace?.name ?? 'No workspace'}</span>
            <Icon name="chevron" size={12} />
          </>
        )}
      </button>
      <div className="tabs" role="tablist" onDoubleClick={(e) => e.target === e.currentTarget && send('tab:new')}>
        {state.tabs.map((tab, index) => {
          const group = tab.groupId ? state.groups.find((g) => g.id === tab.groupId) : undefined;
          const firstOfGroup = !!group && state.tabs[index - 1]?.groupId !== group.id;
          const chip = group && firstOfGroup && (
            <GroupChip
              key={`g-${group.id}`}
              group={group}
              count={state.tabs.filter((t) => t.groupId === group.id).length}
              onDropTab={() => {
                if (dragId !== null) send('tab:set-group', { tabId: dragId, groupId: group.id });
                setDragId(null);
              }}
            />
          );
          if (group?.collapsed) return chip ? <Fragment key={`gf-${group.id}`}>{chip}</Fragment> : null;
          const active = tab.id === state.activeTabId;
          const inSplit = !!split && (split.leftTabId === tab.id || split.rightTabId === tab.id);
          return (
            <Fragment key={tab.id}>
            {chip}
            <div
              role="tab"
              aria-selected={active}
              className={`tab ${group ? `grouped gc-${group.color}` : ''} ${active ? 'active' : ''} ${tab.pinned ? 'pinned' : ''} ${tab.sleeping ? 'sleeping' : ''} ${inSplit ? 'in-split' : ''} ${dragId === tab.id ? 'dragging' : ''}`}
              title={`${tab.title}\n${tab.url}${tab.sleeping ? '\n(sleeping to save memory)' : ''}`}
              draggable
              onDragStart={(e) => {
                setDragId(tab.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => setDragId(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId !== null && dragId !== tab.id) send('tab:move', { tabId: dragId, index });
                setDragId(null);
              }}
              onMouseDown={(e) => {
                if (e.button === 0) send('tab:activate', tab.id);
              }}
              onAuxClick={(e) => {
                if (e.button === 1) send('tab:close', tab.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                send('tab:context-menu', tab.id);
              }}
            >
              <Favicon tab={tab} />
              {!tab.pinned && <span className="tab-title">{tab.title || 'New Tab'}</span>}
              {(tab.audible || tab.muted) && (
                <button
                  className="tab-audio"
                  title={tab.muted ? 'Unmute' : 'Mute'}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => send('tab:mute', tab.id)}
                >
                  <Icon name={tab.muted ? 'muted' : 'speaker'} size={13} />
                </button>
              )}
              {!tab.pinned && (
                <button className="tab-close" title="Close tab (Ctrl+W)" onMouseDown={(e) => e.stopPropagation()} onClick={() => send('tab:close', tab.id)}>
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
            </Fragment>
          );
        })}
        <button className="new-tab" title="New tab (Ctrl+T)" onClick={() => send('tab:new')}>
          <Icon name="plus" />
        </button>
      </div>
      <div className="titlebar-drag" />
    </div>
  );
}
