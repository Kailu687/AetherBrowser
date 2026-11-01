import { useEffect, useRef } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { oneDark } from '@codemirror/theme-one-dark';
import { loadLanguage } from './cm.js';

/** A CodeMirror 6 editor bound to a string value. */
export function CodeEditor({ value, onChange, cm, dark, onRun }: { value: string; onChange: (v: string) => void; cm: string; dark: boolean; onRun?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const theme = useRef(new Compartment());
  const cb = useRef({ onChange, onRun });
  cb.current = { onChange, onRun };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab, { key: 'Mod-Enter', run: () => (cb.current.onRun?.(), true) }, { key: 'F5', run: () => (cb.current.onRun?.(), true) }]),
          lang.current.of([]),
          theme.current.of(dark ? oneDark : []),
          EditorView.updateListener.of((u) => u.docChanged && cb.current.onChange(u.state.doc.toString())),
          EditorView.theme({ '&': { height: '100%', fontSize: '13.5px' }, '.cm-scroller': { fontFamily: "'Cascadia Code', Consolas, monospace" } }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    let alive = true;
    void loadLanguage(cm).then((ext) => alive && view.current?.dispatch({ effects: lang.current.reconfigure(ext ?? []) }));
    return () => {
      alive = false;
    };
  }, [cm]);

  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(dark ? oneDark : []) });
  }, [dark]);

  return <div className="ce-host" ref={host} />;
}
