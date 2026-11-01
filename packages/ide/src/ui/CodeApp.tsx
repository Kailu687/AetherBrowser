import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkbenchAppApi } from '@aether/plugin-api';
import { LANGUAGES, languageById, languageForFile, type LanguageDef } from '../languages.js';
import type { RunResult, ToolchainInfo } from '../runner.js';
import { CodeEditor } from './CodeEditor.js';
import './code.css';

interface Line {
  stream: 'stdout' | 'stderr' | 'info' | 'stdin';
  text: string;
}
type Consent = null | 'process.run' | 'process.servers';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.dataset.mode !== 'light');
  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.dataset.mode !== 'light'));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
    return () => o.disconnect();
  }, []);
  return dark;
}

/** Studio Code: write and run code in many languages using the toolchains installed on this PC. */
export function CodeApp({ api }: { api: WorkbenchAppApi }) {
  const dark = useDark();
  const [files, setFiles] = useState<{ name: string; modified: number }[]>([]);
  const [name, setName] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [lang, setLang] = useState<LanguageDef>(languageById('python')!);
  const [tools, setTools] = useState<ToolchainInfo[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [table, setTable] = useState<RunResult['table']>(undefined);
  const [running, setRunning] = useState<string | null>(null);
  const [stdin, setStdin] = useState('');
  const [presetInput, setPresetInput] = useState('');
  const [consent, setConsent] = useState<Consent>(null);
  const [bottom, setBottom] = useState<'output' | 'terminal'>('output');
  const [diskPath, setDiskPath] = useState<string | null>(null);
  const saveT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRun = useRef<(() => void) | null>(null);

  const loadFiles = useCallback(() => void api.invoke<typeof files>('scratch.list').then(setFiles), [api]);
  useEffect(() => {
    loadFiles();
    void api.invoke<ToolchainInfo[]>('toolchains').then(setTools);
  }, [api, loadFiles]);

  useEffect(() => {
    const offs = [
      api.on('run.output', (p) => {
        const { id, stream, chunk } = p as { id: string; stream: 'stdout' | 'stderr'; chunk: string };
        if (id === runningRef.current) setLines((l) => [...l, { stream, text: chunk }].slice(-4000));
      }),
      api.on('run.done', (p) => {
        const { id, result } = p as { id: string; result: RunResult };
        if (id !== runningRef.current) return;
        runningRef.current = null;
        setRunning(null);
        setTable(result.table);
        if (result.missing) setLines((l) => [...l, { stream: 'info', text: `\n${lang.name} needs ${result.missing!.tool.join(' or ')}, which isn't installed (or isn't on PATH).${result.missing!.install ? ` Get it from ${result.missing!.install}` : ''}\n` }]);
        else if (result.timedOut) setLines((l) => [...l, { stream: 'info', text: '\n[stopped: time limit reached]\n' }]);
        else setLines((l) => [...l, { stream: 'info', text: `\n[${result.phase === 'compile' && !result.ok ? 'compile failed' : `exit ${result.exitCode}`} · ${(result.durationMs / 1000).toFixed(2)} s]\n` }]);
      }),
    ];
    return () => offs.forEach((o) => o());
  }, [api, lang.name]);
  const runningRef = useRef<string | null>(null);

  const openScratch = async (n: string) => {
    setName(n);
    setDiskPath(null);
    setLang(languageForFile(n));
    setCode(await api.invoke<string>('scratch.read', { name: n }));
  };
  const newFile = async (l: LanguageDef) => {
    let n = `untitled.${l.ext[0]}`;
    for (let i = 2; files.some((f) => f.name === n); i++) n = `untitled-${i}.${l.ext[0]}`;
    if (l.id === 'java') n = files.some((f) => f.name === 'Main.java') ? `Main${Date.now() % 1000}.java` : 'Main.java';
    await api.invoke('scratch.write', { name: n, text: l.hello });
    loadFiles();
    setName(n);
    setLang(l);
    setCode(l.hello);
  };
  const onEdit = (v: string) => {
    setCode(v);
    if (!name || diskPath) return;
    if (saveT.current) clearTimeout(saveT.current);
    saveT.current = setTimeout(() => void api.invoke('scratch.write', { name, text: v }), 500);
  };

  const run = async () => {
    if (lang.run === 'preview') return void api.invoke('preview', { html: code });
    if (lang.run === 'none') return setLines([{ stream: 'info', text: `${lang.name} files are not runnable. Pick a programming language to run code.\n` }]);
    setLines([{ stream: 'info', text: `▶ ${lang.name}${presetInput ? ' (with input)' : ''}\n` }]);
    setTable(undefined);
    setBottom('output');
    try {
      const { id } = await api.invoke<{ id: string }>('run', { lang: lang.id, code, stdin: presetInput || undefined });
      runningRef.current = id;
      setRunning(id);
    } catch (e) {
      const m = errText(e);
      if (m.includes('permission-required:studio:process.run')) {
        pendingRun.current = () => void run();
        setConsent('process.run');
      } else setLines((l) => [...l, { stream: 'stderr', text: m + '\n' }]);
    }
  };
  const grant = async (perm: Exclude<Consent, null>) => {
    await api.invokeModule('aether.modules', 'consent', { permission: perm, allow: true });
    setConsent(null);
    pendingRun.current?.();
    pendingRun.current = null;
  };
  const sendInput = () => {
    if (!running) return;
    void api.invoke('run.input', { id: running, text: stdin });
    setLines((l) => [...l, { stream: 'stdin', text: stdin + '\n' }]);
    setStdin('');
  };
  const tool = tools.find((t) => t.lang === lang.id);
  const grouped = useMemo(() => LANGUAGES.filter((l) => l.run !== 'none' || ['json', 'markdown', 'css', 'yaml'].includes(l.id)), []);

  return (
    <div className="ce">
      <aside className="ce-side">
        <div className="ce-side-head">
          <b>Files</b>
          <span className="grow" />
          <NewMenu langs={grouped} onPick={(l) => void newFile(l)} />
        </div>
        {files.map((f) => (
          <div key={f.name} className={`ce-file ${f.name === name && !diskPath ? 'on' : ''}`} onClick={() => void openScratch(f.name)}>
            <span className="ellipsis grow">{f.name}</span>
            <button
              className="wb-icon small"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete ${f.name}?`)) void api.invoke('scratch.delete', { name: f.name }).then(() => (f.name === name && setName(null), loadFiles()));
              }}
            >
              ✕
            </button>
          </div>
        ))}
        {!files.length && <p className="small muted ce-pad">Create a file with + to start. Files are kept in AETHER's data folder.</p>}
        <div className="ce-pad col">
          <button
            className="wb-btn"
            onClick={async () => {
              const f = await api.invoke<{ path: string; name: string; text: string } | null>('file.open');
              if (!f) return;
              setDiskPath(f.path);
              setName(f.name);
              setLang(languageForFile(f.name));
              setCode(f.text);
            }}
          >
            Open from disk…
          </button>
          <button className="wb-btn" disabled={!name} onClick={async () => name && setDiskPath((await api.invoke<{ path: string } | null>('file.saveAs', { name, text: code }))?.path ?? diskPath)}>
            Save as…
          </button>
          <h5>Toolchains on this PC</h5>
          {tools
            .filter((t) => languageById(t.lang)!.run !== 'none')
            .map((t) => (
              <div key={t.lang} className="small ce-tool" title={t.version ?? ''}>
                <span className={t.available ? 'ok' : 'muted'}>{t.available ? '●' : '○'}</span> {languageById(t.lang)!.name}
                {!t.available && languageById(t.lang)!.install && (
                  <button className="wb-link small" onClick={() => api.openUrl(languageById(t.lang)!.install!)}>
                    get
                  </button>
                )}
              </div>
            ))}
          <button className="wb-link small" onClick={() => void api.invoke<ToolchainInfo[]>('toolchains', { refresh: true }).then(setTools)}>
            Re-check
          </button>
        </div>
      </aside>
      <section className="ce-main">
        <header className="ce-bar">
          <b className="ellipsis">{name ?? 'No file'}</b>
          {diskPath && <small className="muted ellipsis" title={diskPath}>{diskPath}</small>}
          <span className="grow" />
          <select className="wb-select" value={lang.id} onChange={(e) => setLang(languageById(e.target.value)!)}>
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          {tool && <span className={`ce-pill ${tool.available ? 'ok' : 'bad'}`} title={tool.path ?? ''}>{tool.available ? tool.version ?? 'ready' : 'not installed'}</span>}
          <input className="wb-input" style={{ width: 160 }} placeholder="Program input (stdin)" value={presetInput} onChange={(e) => setPresetInput(e.target.value)} title="Sent to the program when it starts. You can also type while it runs." />
          {running ? (
            <button className="wb-btn danger" onClick={() => void api.invoke('run.kill', { id: running })}>
              ■ Stop
            </button>
          ) : (
            <button className="wb-btn primary" disabled={!name && !code} onClick={() => void run()} title="Run (Ctrl+Enter or F5)">
              {lang.run === 'preview' ? '👁 Preview' : '▶ Run'}
            </button>
          )}
        </header>
        <div className="ce-editor">{name || code ? <CodeEditor value={code} onChange={onEdit} cm={lang.cm} dark={dark} onRun={() => void run()} /> : <Welcome langs={grouped} onPick={(l) => void newFile(l)} />}</div>
        <div className="ce-bottom">
          <nav className="ce-btabs">
            <button className={bottom === 'output' ? 'on' : ''} onClick={() => setBottom('output')}>
              Output
            </button>
            <button className={bottom === 'terminal' ? 'on' : ''} onClick={() => setBottom('terminal')}>
              Terminal
            </button>
            <span className="grow" />
            {bottom === 'output' && (
              <button className="wb-link small" onClick={() => setLines([])}>
                Clear
              </button>
            )}
          </nav>
          {bottom === 'output' ? (
            <div className="ce-out">
              <pre>
                {lines.map((l, i) => (
                  <span key={i} className={l.stream}>
                    {l.text}
                  </span>
                ))}
              </pre>
              {table?.map((t, i) => (
                <table key={i} className="wb-table ce-sql">
                  <thead>
                    <tr>{t.columns.map((c) => <th key={c}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {t.rows.slice(0, 500).map((r, j) => (
                      <tr key={j}>{r.map((v, k) => <td key={k}>{v === null ? 'NULL' : String(v)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              ))}
              {running && (
                <div className="row ce-stdin">
                  <input className="wb-input grow mono" placeholder="Type input for the running program and press Enter" value={stdin} onChange={(e) => setStdin(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendInput()} />
                </div>
              )}
            </div>
          ) : (
            <Terminal api={api} onConsent={(retry) => ((pendingRun.current = retry), setConsent('process.servers'))} />
          )}
        </div>
      </section>
      {consent && (
        <div className="wb-modal-back">
          <div className="wb-modal">
            <h3>{consent === 'process.run' ? 'Allow Code to run programs on this PC?' : 'Allow the terminal to run commands?'}</h3>
            <p className="small">
              {consent === 'process.run'
                ? 'AETHER will run your code with the compilers and interpreters installed on this computer (for example Python or gcc), with your Windows account’s permissions. Each run stops after 30 seconds unless it finishes sooner. Nothing runs unless you press Run.'
                : 'Commands you type run in a command prompt with your Windows account’s permissions, until you stop them. Only type commands you understand.'}
            </p>
            <p className="small muted">You can turn this off again in Settings → Add-ons & permissions.</p>
            <div className="row">
              <span className="grow" />
              <button className="wb-btn" onClick={() => setConsent(null)}>
                Not now
              </button>
              <button className="wb-btn primary" onClick={() => void grant(consent)}>
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NewMenu({ langs, onPick }: { langs: LanguageDef[]; onPick: (l: LanguageDef) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="wb-menu-wrap">
      <button className="wb-icon" title="New file" onClick={() => setOpen(!open)}>
        ＋
      </button>
      {open && (
        <div className="wb-menu ce-newmenu" style={{ left: 0, right: 'auto' }} onMouseLeave={() => setOpen(false)}>
          {langs.map((l) => (
            <button key={l.id} onClick={() => (setOpen(false), onPick(l))}>
              {l.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Welcome({ langs, onPick }: { langs: LanguageDef[]; onPick: (l: LanguageDef) => void }) {
  return (
    <div className="ce-welcome">
      <h2>Code</h2>
      <p className="muted">Write and run code in {langs.filter((l) => l.run !== 'none').length} languages. JavaScript, TypeScript, SQL and HTML work out of the box; others use the compilers installed on your PC. For folders, Git, servers and a REST client, install Developer Studio from the Add-on Store.</p>
      <div className="ce-langs">
        {langs.map((l) => (
          <button key={l.id} className="wb-btn" onClick={() => onPick(l)}>
            {l.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function Terminal({ api, onConsent }: { api: WorkbenchAppApi; onConsent: (retry: () => void) => void }) {
  const [cmd, setCmd] = useState('');
  const [log, setLog] = useState<Line[]>([{ stream: 'info', text: 'Basic terminal: each line runs as a command in AETHER’s scratch folder. Use Developer Studio for project folders and long-running servers.\n' }]);
  const [cur, setCur] = useState<string | null>(null);
  const curRef = useRef<string | null>(null);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const offs = [
      api.on('term.output', (p) => {
        const { id, stream, chunk } = p as { id: string; stream: 'stdout' | 'stderr'; chunk: string };
        if (id === curRef.current) setLog((l) => [...l, { stream, text: chunk }].slice(-3000));
      }),
      api.on('term.exit', (p) => {
        const { id, code } = p as { id: string; code: number | null };
        if (id === curRef.current) {
          setLog((l) => [...l, { stream: 'info', text: `[exit ${code}]\n` }]);
          curRef.current = null;
          setCur(null);
        }
      }),
    ];
    return () => offs.forEach((o) => o());
  }, [api]);
  useEffect(() => {
    box.current?.scrollTo(0, box.current.scrollHeight);
  }, [log]);
  const exec = async (c: string) => {
    if (cur) {
      void api.invoke('term.input', { id: cur, text: c });
      setLog((l) => [...l, { stream: 'stdin', text: c + '\n' }]);
      return;
    }
    setLog((l) => [...l, { stream: 'stdin', text: `> ${c}\n` }]);
    try {
      const p = await api.invoke<{ id: string }>('term.start', { command: c });
      curRef.current = p.id;
      setCur(p.id);
    } catch (e) {
      const m = errText(e);
      if (m.includes('permission-required')) onConsent(() => void exec(c));
      else setLog((l) => [...l, { stream: 'stderr', text: m + '\n' }]);
    }
  };
  return (
    <div className="ce-out term">
      <pre ref={box}>
        {log.map((l, i) => (
          <span key={i} className={l.stream}>
            {l.text}
          </span>
        ))}
      </pre>
      <div className="row ce-stdin">
        <span className="mono muted">{cur ? '…' : '>'}</span>
        <input className="wb-input grow mono" placeholder={cur ? 'Input for the running command' : 'Command, e.g. python --version'} value={cmd} onChange={(e) => setCmd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && cmd.trim() && (void exec(cmd), setCmd(''))} />
        {cur && (
          <button className="wb-btn small danger" onClick={() => void api.invoke('term.stop', { id: cur })}>
            Stop
          </button>
        )}
      </div>
    </div>
  );
}
