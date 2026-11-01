import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { displayUrl } from '@aether/omnibox';
import type { Suggestion, TabState, WindowState } from '../../shared/types';
import type { Popover } from '../App';
import { call, send } from '../api';
import type { PanelId } from './Sidebar';
import { Icon } from './Icon';
import { toast } from './Toasts';

interface Props {
  state: WindowState;
  tab: TabState | null;
  omniboxRef: RefObject<HTMLInputElement | null>;
  bangs: { trigger: string; name: string; category: string }[];
  popover: Popover;
  setPopover: (p: Popover) => void;
  panel: PanelId | null;
  setPanel: (p: PanelId | null) => void;
}

const KIND_LABEL: Record<Suggestion['kind'], string> = { history: 'History', bookmark: 'Bookmark', search: 'Search', url: 'Open', bang: 'Shortcut', tab: 'Tab', calc: 'Calc' };

export function Toolbar({ state, tab, omniboxRef, popover, setPopover, panel, setPanel }: Props) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [selected, setSelected] = useState(0);
  const reqId = useRef(0);

  // Show the active tab's URL whenever the box is not being edited.
  useEffect(() => {
    if (!focused) setValue(tab ? displayUrl(tab.url) : '');
  }, [tab?.url, focused]);
  // Switching tabs always resets the box, even while it has focus.
  useEffect(() => {
    if (!tab) return;
    setValue(focused && !tab.url.startsWith('aether://newtab') ? tab.url : displayUrl(tab.url));
    setSuggestions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.id]);

  const updateSuggestions = (text: string) => {
    const id = ++reqId.current;
    if (!text.trim()) {
      setSuggestions([]);
      if (popover === 'omnibox') setPopover(null);
      return;
    }
    void call<Suggestion[]>('omnibox:suggest', text).then((list) => {
      if (id !== reqId.current) return;
      setSuggestions(list);
      setSelected(0);
      if (list.length && focused) setPopover('omnibox');
    });
  };

  const commit = (s?: Suggestion) => {
    // Enter on a calculation (or "=..." typed) copies the answer instead of searching.
    const calc = s ?? (suggestions[0]?.kind === 'calc' && value.trim().startsWith('=') ? suggestions[0] : undefined);
    if (calc?.kind === 'calc') {
      if (calc.copy) void call('clipboard:write', calc.copy).then(() => toast(`Copied ${calc.copy}`));
      return;
    }
    if (s?.kind === 'tab' && s.tabId) send('tab:activate', s.tabId);
    else send('tab:navigate', { input: s ? s.url : value, tabId: tab?.id });
    setSuggestions([]);
    setPopover(null);
    omniboxRef.current?.blur();
  };

  const loading = tab?.loading;
  /** Native menus draw above web pages, unlike HTML popovers. */
  const openMenu = (e: ReactMouseEvent<HTMLButtonElement>, section?: 'theme') => {
    const r = e.currentTarget.getBoundingClientRect();
    send('app:menu', { x: Math.round(r.right - 4), y: Math.round(r.bottom + 2), ...(section ? { section } : {}) });
  };
  const showSuggest = popover === 'omnibox' && focused && suggestions.length > 0;

  return (
    <div className="toolbar">
      <div className="nav">
        <button className="icon-btn" disabled={!tab?.canGoBack} title="Back (Alt+Left)" onClick={() => tab && send('tab:back', tab.id)}>
          <Icon name="back" />
        </button>
        <button className="icon-btn" disabled={!tab?.canGoForward} title="Forward (Alt+Right)" onClick={() => tab && send('tab:forward', tab.id)}>
          <Icon name="forward" />
        </button>
        <button className="icon-btn" title={loading ? 'Stop' : 'Reload (Ctrl+R)'} onClick={() => tab && send(loading ? 'tab:stop' : 'tab:reload', tab.id)}>
          <Icon name={loading ? 'stop' : 'reload'} />
        </button>
      </div>

      <div className={`omnibox ${focused ? 'focused' : ''}`}>
        <span className={`omni-security ${tab?.secure ? 'secure' : 'insecure'}`} title={tab?.secure ? 'Connection is encrypted' : 'Connection is not encrypted'}>
          <Icon name={tab?.secure ? 'lock' : 'info'} size={14} />
        </span>
        <input
          ref={omniboxRef}
          value={value}
          spellCheck={false}
          placeholder="Search, type a URL, or try !scholar, !ds, !gh…"
          aria-label="Address and search bar"
          onFocus={(e) => {
            setFocused(true);
            if (tab && !tab.url.startsWith('aether://newtab')) setValue(tab.url);
            requestAnimationFrame(() => e.target.select());
          }}
          onBlur={() => {
            setFocused(false);
            setTimeout(() => {
              if (document.activeElement !== omniboxRef.current) {
                setSuggestions([]);
                if (popover === 'omnibox') setPopover(null);
              }
            }, 120);
          }}
          onChange={(e) => {
            setValue(e.target.value);
            updateSuggestions(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(showSuggest && selected > 0 ? suggestions[selected] : undefined);
            } else if (e.key === 'ArrowDown' && suggestions.length) {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, suggestions.length - 1));
            } else if (e.key === 'ArrowUp' && suggestions.length) {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Escape') {
              setValue(tab ? displayUrl(tab.url) : '');
              setSuggestions([]);
              setPopover(null);
              e.currentTarget.blur();
            }
          }}
        />
        {tab && tab.zoom !== 1 && (
          <button className="pill" title="Reset zoom (Ctrl+0)" onClick={() => send('tab:zoom', { tabId: tab.id, dir: 0 })}>
            {Math.round(tab.zoom * 100)}%
          </button>
        )}
        {tab && /^(https?:|aether:\/\/reader)/.test(tab.url) && (
          <button className={`icon-btn small ${tab.url.startsWith('aether://reader') ? 'on' : ''}`} title="Reader view (Ctrl+Alt+R)" onClick={() => send('tab:reader', tab.id)}>
            <Icon name="book" />
          </button>
        )}
        {state.savedLogins > 0 && (
          <button className="icon-btn small on key-btn" title={`${state.savedLogins} saved login${state.savedLogins === 1 ? '' : 's'} for this site`} onClick={() => setPanel('passwords')}>
            <Icon name="key" />
          </button>
        )}
        {!state.isPrivate && (
          <button className={`icon-btn small ${state.bookmarked ? 'on' : ''}`} title="Bookmark this page (Ctrl+D)" onClick={() => send('bookmarks:toggle')}>
            <Icon name="star" />
          </button>
        )}
        {showSuggest && (
          <ul className="suggestions" role="listbox">
            {suggestions.map((s, i) => (
              <li
                key={`${s.kind}-${s.url}-${i}`}
                role="option"
                aria-selected={i === selected}
                className={i === selected ? 'selected' : ''}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(s);
                }}
                onMouseEnter={() => setSelected(i)}
              >
                <span className={`s-kind k-${s.kind}`}>{KIND_LABEL[s.kind]}</span>
                <span className="s-title">{s.title}</span>
                <span className="s-url">{s.detail ?? displayUrl(s.url)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="actions">
        <button className={`icon-btn ${state.split ? 'on' : ''}`} title="Split view (Ctrl+\)" onClick={() => send('split:toggle')}>
          <Icon name="split" />
        </button>
        <button className={`icon-btn ${panel === 'downloads' ? 'on' : ''}`} title="Downloads (Ctrl+J)" onClick={() => setPanel(panel === 'downloads' ? null : 'downloads')}>
          <Icon name="download" />
        </button>
        <button className={`icon-btn ${panel ? 'on' : ''}`} title="Sidebar (Ctrl+B)" onClick={() => setPanel(panel ? null : 'notes')}>
          <Icon name="sidebar" />
        </button>
        <button className="icon-btn" title="Theme" onClick={(e) => openMenu(e, 'theme')}>
          <Icon name="palette" />
        </button>
        <button className="profile-btn" title={`Profile: ${state.profile.name}`} onClick={() => setPopover(popover === 'profile' ? null : 'profile')}>
          {state.isPrivate ? <Icon name="mask" /> : <span className="avatar">{state.profile.icon || state.profile.name.slice(0, 1).toUpperCase()}</span>}
          <span className="profile-name">{state.isPrivate ? 'Private' : state.profile.name}</span>
        </button>
        <button className="icon-btn" title="Menu" onClick={(e) => openMenu(e)}>
          <Icon name="menu" />
        </button>
      </div>
    </div>
  );
}
