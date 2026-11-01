import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Typography from '@tiptap/extension-typography';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import type { WorkbenchAppApi } from '@aether/plugin-api';
import { Bibliography, STYLES, type Reference, type StyleId } from '@aether/citations';
import { BibliographyNode, Citation, CiteContext, MathBlock, MathInline, PageBreak, ParagraphFormat } from './extensions.js';
import { docStats, outline, type PMNode } from '../doc.js';
import { recommend, type Suggestion } from '../assist/recommend.js';
import { aiCheck, type AiCheckResult } from '../assist/ai-check.js';
import { citationOrder } from '../doc.js';
import { toHtml, toLatex, toMarkdown, type ExportContext } from '../export/text.js';
import type { WriterDoc, WriterDocSummary } from '../store.js';
import type { DocTemplate } from '../templates.js';
import './writer.css';

type TemplateInfo = Omit<DocTemplate, 'build'>;
interface LibraryItem {
  id: string;
  ref: Reference;
}

const FONTS = ['Calibri', 'Times New Roman', 'Georgia', 'Cambria', 'Arial', 'Segoe UI', 'Garamond', 'Consolas'];
const SIZES = ['9pt', '10pt', '10.5pt', '11pt', '12pt', '14pt', '16pt', '18pt', '24pt', '32pt'];

export function WriterApp({ api }: { api: WorkbenchAppApi }) {
  const [openId, setOpenId] = useState<string | null>(api.arg ?? null);
  useEffect(() => {
    if (api.arg) setOpenId(api.arg);
  }, [api.arg]);
  return openId ? <DocEditor key={openId} api={api} id={openId} onClose={() => setOpenId(null)} /> : <Home api={api} onOpen={setOpenId} />;
}

// ---------------------------------------------------------------------------- Home

function Home({ api, onOpen }: { api: WorkbenchAppApi; onOpen: (id: string) => void }) {
  const [docs, setDocs] = useState<WriterDocSummary[] | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [q, setQ] = useState('');
  const load = useCallback(() => void api.invoke<WriterDocSummary[]>('list').then(setDocs), [api]);
  useEffect(() => {
    load();
    void api.invoke<TemplateInfo[]>('templates').then(setTemplates);
  }, [api, load]);
  const create = async (template: string, content?: PMNode, title?: string) => {
    const d = await api.invoke<WriterDoc>('create', { template, content, title });
    onOpen(d.id);
  };
  const importFile = async (file: File) => {
    const name = file.name.replace(/\.[^.]+$/, '');
    const { generateJSON } = await import('@tiptap/core');
    let html = '';
    if (/\.docx$/i.test(file.name)) {
      const mammoth = (await import('mammoth')) as unknown as { convertToHtml(i: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }> };
      html = (await (mammoth.convertToHtml ?? (mammoth as unknown as { default: typeof mammoth }).default.convertToHtml)({ arrayBuffer: await file.arrayBuffer() })).value;
    } else if (/\.html?$/i.test(file.name)) html = await file.text();
    else {
      const text = await file.text();
      html = text
        .split(/\n{2,}/)
        .map((b) => {
          const m = b.match(/^(#{1,3})\s+(.*)/);
          const e = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
          return m ? `<h${m[1].length}>${e(m[2])}</h${m[1].length}>` : `<p>${e(b).replace(/\n/g, '<br>')}</p>`;
        })
        .join('');
    }
    const json = generateJSON(html, extensions()) as PMNode;
    await create('blank', json, name);
  };
  const shown = (docs ?? []).filter((d) => !q || d.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="wr-home">
      <section className="wr-hero">
        <div>
          <h1>Writer</h1>
          <p className="muted">Documents and research papers, offline. Real styles, indentation, equations, citations, Word/PDF/LaTeX export, a recommendation engine and an AI-text indicator.</p>
        </div>
        <label className="wb-btn">
          Open file…
          <input type="file" accept=".docx,.md,.markdown,.txt,.html,.htm" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} />
        </label>
      </section>
      <h3 className="wr-h">Start something new</h3>
      <div className="wr-templates">
        {templates.map((t) => (
          <button key={t.id} className="wr-tpl" onClick={() => void create(t.id)}>
            <div className={`wr-tpl-page ${t.kind}`}>
              <span />
              <span />
              <span />
              <span />
            </div>
            <b>{t.name}</b>
            <small className="muted">{t.description}</small>
          </button>
        ))}
      </div>
      <div className="wr-h row">
        <h3>Recent documents</h3>
        <input className="wb-input" placeholder="Search documents" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {docs && !docs.length && <p className="muted">No documents yet. Pick a template above.</p>}
      <div className="wr-docs">
        {shown.map((d) => (
          <div key={d.id} className="wr-doc" onClick={() => onOpen(d.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(d.id)}>
            <b className="ellipsis">{d.title}</b>
            <small className="muted">
              {d.words.toLocaleString()} words · {STYLES[d.style as StyleId]?.label ?? d.style} · {new Date(d.updatedAt).toLocaleString()}
            </small>
            <span className="grow" />
            <button
              className="wb-icon"
              title="Duplicate"
              onClick={(e) => {
                e.stopPropagation();
                void api.invoke('duplicate', { id: d.id }).then(load);
              }}
            >
              ⧉
            </button>
            <button
              className="wb-icon danger"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete “${d.title}”? This cannot be undone.`)) void api.invoke('delete', { id: d.id }).then(load);
              }}
            >
              🗑
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- Editor

function extensions() {
  return [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right', 'justify'] }),
    Highlight.configure({ multicolor: true }),
    Subscript,
    Superscript,
    Typography,
    Image.configure({ allowBase64: true }),
    TableKit.configure({ table: { resizable: true } }),
    TextStyleKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    CharacterCount,
    Placeholder.configure({ placeholder: 'Start writing… (Tab indents, Ctrl+Shift+C cites a source)' }),
    ParagraphFormat,
    Citation,
    BibliographyNode,
    MathInline,
    MathBlock,
    PageBreak,
  ];
}

type Pane = 'outline' | 'review' | 'aicheck' | 'sources' | 'versions';

function DocEditor({ api, id, onClose }: { api: WorkbenchAppApi; id: string; onClose: () => void }) {
  const [doc, setDoc] = useState<WriterDoc | null>(null);
  const [lib, setLib] = useState<Map<string, Reference>>(new Map());
  const [pane, setPane] = useState<Pane | null>('review');
  const [saved, setSaved] = useState<'saved' | 'saving' | 'error'>('saved');
  const [zoom, setZoom] = useState(1);
  const [find, setFind] = useState(false);
  const [citeVersion, setCiteVersion] = useState(0);
  const [picker, setPicker] = useState<{ pos?: number; ids: string[] } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const docRef = useRef<WriterDoc | null>(null);
  docRef.current = doc;

  const loadLib = useCallback(
    () =>
      void api
        .invokeModule<LibraryItem[]>('research', 'library.list', {})
        .then((items) => setLib(new Map(items.map((i) => [i.ref.id, i.ref]))))
        .catch(() => setLib(new Map())),
    [api],
  );
  useEffect(() => {
    void api.invoke<WriterDoc | null>('get', { id }).then(setDoc);
    loadLib();
  }, [api, id, loadLib]);

  const save = useCallback(
    (patch: Partial<WriterDoc>) => {
      setSaved('saving');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void api
          .invoke('update', { id, patch })
          .then(() => setSaved('saved'))
          .catch(() => setSaved('error'));
      }, 700);
    },
    [api, id],
  );

  const editor = useEditor(
    {
      extensions: extensions(),
      content: doc?.content ?? undefined,
      editorProps: { attributes: { class: 'ws-page-body', spellcheck: 'true' } },
      onUpdate: ({ editor: ed }) => {
        save({ content: ed.getJSON() as PMNode });
        setCiteVersion((v) => v + 1);
      },
    },
    [doc?.id],
  );

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const json = useEditorState({ editor, selector: (s) => (s.editor ? (s.editor.getJSON() as PMNode) : null) });
  const bib = useMemo(() => {
    if (!doc) return null;
    const b = new Bibliography(doc.style, [...lib.values()]);
    if (json) for (const cid of citationOrder(json)) if (lib.has(cid)) b.cite(cid);
    return b;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.style, lib, citeVersion, json]);

  // Citation node views read the bibliography through context; force a re-render when it changes.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('cite-refresh', true));
  }, [bib, editor]);

  const exportCtx = (): ExportContext => ({ title: doc?.title ?? 'Document', style: doc?.style ?? 'apa', library: lib, font: doc?.font });

  const doExport = async (fmt: 'docx' | 'pdf' | 'html' | 'md' | 'tex' | 'txt') => {
    if (!editor || !doc) return;
    const d = editor.getJSON() as PMNode;
    const name = doc.title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'document';
    if (fmt === 'docx') {
      const { toDocx } = await import('../export/docx.js');
      api.download(`${name}.docx`, (await toDocx(d, exportCtx())) as Blob, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    } else if (fmt === 'html' || fmt === 'pdf') {
      const katex = (await import('katex')) as unknown as { default?: { renderToString: (t: string, o: object) => string }; renderToString: (t: string, o: object) => string };
      const k = katex.default ?? katex;
      const html = toHtml(d, exportCtx(), { standalone: true, katex: (t, display) => k.renderToString(t, { displayMode: display, throwOnError: false, output: 'mathml' }) });
      if (fmt === 'html') api.download(`${name}.html`, html, 'text/html');
      else {
        const bytes = await api.invoke<Uint8Array>('pdf', { html });
        api.download(`${name}.pdf`, new Blob([bytes as BlobPart], { type: 'application/pdf' }), 'application/pdf');
      }
    } else if (fmt === 'md') api.download(`${name}.md`, toMarkdown(d, exportCtx()), 'text/markdown');
    else if (fmt === 'txt') api.download(`${name}.txt`, editor.getText(), 'text/plain');
    else {
      const { tex, bib: bibtex } = toLatex(d, exportCtx());
      api.download(`${name}.tex`, tex, 'application/x-tex');
      if (bibtex) setTimeout(() => api.download('references.bib', bibtex, 'application/x-bibtex'), 400);
    }
  };

  const insertCitation = (ids: string[], pos?: number) => {
    if (!editor || !ids.length) return;
    if (pos !== undefined) {
      editor.chain().focus().command(({ tr }) => {
        tr.setNodeMarkup(pos, undefined, { ids });
        return true;
      }).run();
    } else editor.chain().focus().insertContent({ type: 'citation', attrs: { ids } }).run();
  };

  const clip = async () => {
    const c = await api.invoke<{ url: string; title: string; selection: string } | null>('clip');
    if (!c || !editor) return alert('Open a web page in the browser (try the split view) and select some text first.');
    let citeId: string | null = null;
    try {
      const r = await api.invokeModule<{ item?: { ref: Reference } }>('research', 'library.captureTab', {});
      citeId = r.item?.ref.id ?? null;
      loadLib();
    } catch {
      /* page can't be captured; insert the link instead */
    }
    const quote = c.selection || c.title;
    editor
      .chain()
      .focus()
      .insertContent([
        { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: quote }, { type: 'text', text: ' ' }, citeId ? { type: 'citation', attrs: { ids: [citeId] } } : { type: 'text', text: c.title, marks: [{ type: 'link', attrs: { href: c.url } }] }] }] },
        { type: 'paragraph' },
      ])
      .run();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void api.invoke('snapshot', { id, label: 'Saved (Ctrl+S)' });
        setSaved('saved');
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        setPicker({ ids: [] });
      } else if (mod && (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'h')) {
        e.preventDefault();
        setFind(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [api, id]);

  if (!doc) return <div className="wr-loading">Loading…</div>;
  const stats = json ? docStats(json) : null;

  return (
    <CiteContext.Provider value={{ bib, version: citeVersion, onEdit: (pos, ids) => setPicker({ pos, ids }) }}>
      <div className="wr-editor" style={{ ['--wr-font' as string]: `'${doc.font}'` }}>
        <header className="wr-top">
          <button className="wb-icon" title="All documents" onClick={onClose}>
            ←
          </button>
          <input
            className="wr-title"
            value={doc.title}
            onChange={(e) => {
              setDoc({ ...doc, title: e.target.value });
              save({ title: e.target.value });
            }}
          />
          <span className={`wr-saved ${saved}`}>{saved === 'saving' ? 'Saving…' : saved === 'error' ? 'Not saved!' : 'Saved'}</span>
          <span className="grow" />
          <select
            className="wb-select"
            title="Citation style"
            value={doc.style}
            onChange={(e) => {
              const style = e.target.value as StyleId;
              setDoc({ ...doc, style });
              save({ style });
            }}
          >
            {Object.entries(STYLES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
          <ExportMenu onExport={(f) => void doExport(f).catch((e) => alert(`Export failed: ${e instanceof Error ? e.message : e}`))} />
        </header>
        {editor && <Ribbon editor={editor} doc={doc} onFont={(font) => (setDoc({ ...doc, font }), save({ font }))} onCite={() => setPicker({ ids: [] })} onClip={() => void clip()} onFind={() => setFind(true)} />}
        {find && editor && <FindReplace editor={editor} onClose={() => setFind(false)} />}
        <div className="wr-main">
          <div className="wr-scroll">
            <div className="wr-page" style={{ transform: `scale(${zoom})` }}>
              <EditorContent editor={editor} />
            </div>
          </div>
          {pane && json && editor && (
            <aside className="wr-pane">
              <nav className="wr-tabs">
                {(['review', 'aicheck', 'outline', 'sources', 'versions'] as Pane[]).map((p) => (
                  <button key={p} className={pane === p ? 'on' : ''} onClick={() => setPane(p)}>
                    {{ review: 'Suggestions', aicheck: 'AI check', outline: 'Outline', sources: 'Sources', versions: 'Versions' }[p]}
                  </button>
                ))}
                <button className="wb-icon" title="Hide panel" onClick={() => setPane(null)}>
                  ✕
                </button>
              </nav>
              <div className="wr-pane-body">
                {pane === 'outline' && <OutlinePane doc={json} editor={editor} />}
                {pane === 'review' && <ReviewPane doc={json} kind={doc.kind} editor={editor} api={api} />}
                {pane === 'aicheck' && <AiCheckPane editor={editor} />}
                {pane === 'sources' && <SourcesPane api={api} lib={lib} reload={loadLib} onCite={(rid) => insertCitation([rid])} used={citationOrder(json)} />}
                {pane === 'versions' && <VersionsPane api={api} id={id} onRestore={(d) => editor.commands.setContent(d.content as never)} />}
              </div>
            </aside>
          )}
        </div>
        <footer className="wr-status">
          {stats && (
            <>
              <span>{stats.words.toLocaleString()} words</span>
              <span>{stats.characters.toLocaleString()} characters</span>
              <span>~{Math.max(1, Math.ceil(stats.words / 450))} pages</span>
              <span>{stats.readingMinutes} min read</span>
              <span>{stats.citations} citations</span>
            </>
          )}
          <span className="grow" />
          {!pane && (
            <button className="wb-link" onClick={() => setPane('review')}>
              Show suggestions
            </button>
          )}
          <button className="wb-link" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(1)))}>
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button className="wb-link" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(1)))}>
            +
          </button>
        </footer>
        {picker && <CitePicker lib={lib} initial={picker.ids} onClose={() => setPicker(null)} onPick={(ids) => (insertCitation(ids, picker.pos), setPicker(null))} />}
      </div>
    </CiteContext.Provider>
  );
}

function ExportMenu({ onExport }: { onExport: (f: 'docx' | 'pdf' | 'html' | 'md' | 'tex' | 'txt') => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="wb-menu-wrap">
      <button className="wb-btn primary" onClick={() => setOpen(!open)}>
        Export ▾
      </button>
      {open && (
        <div className="wb-menu" onMouseLeave={() => setOpen(false)}>
          {(
            [
              ['docx', 'Word document (.docx)'],
              ['pdf', 'PDF'],
              ['tex', 'LaTeX (.tex + .bib)'],
              ['html', 'Web page (.html)'],
              ['md', 'Markdown (.md)'],
              ['txt', 'Plain text'],
            ] as const
          ).map(([f, l]) => (
            <button key={f} onClick={() => (setOpen(false), onExport(f))}>
              {l}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------- Ribbon

const STYLE_OPTIONS: { id: string; label: string }[] = [
  { id: 'p', label: 'Normal' },
  { id: 'title', label: 'Title' },
  { id: 'subtitle', label: 'Subtitle' },
  { id: 'h1', label: 'Heading 1' },
  { id: 'h2', label: 'Heading 2' },
  { id: 'h3', label: 'Heading 3' },
  { id: 'abstract', label: 'Abstract' },
  { id: 'quote', label: 'Quote' },
  { id: 'caption', label: 'Caption' },
  { id: 'code', label: 'Code' },
];

function Ribbon({ editor, doc, onFont, onCite, onClip, onFind }: { editor: Editor; doc: WriterDoc; onFont: (f: string) => void; onCite: () => void; onClip: () => void; onFind: () => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      sub: e.isActive('subscript'),
      sup: e.isActive('superscript'),
      hl: e.isActive('highlight'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      align: (['left', 'center', 'right', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) ?? 'left',
      style: e.isActive('heading', { level: 1 })
        ? 'h1'
        : e.isActive('heading', { level: 2 })
          ? 'h2'
          : e.isActive('heading', { level: 3 })
            ? 'h3'
            : e.isActive('blockquote')
              ? 'quote'
              : e.isActive('codeBlock')
                ? 'code'
                : ((e.getAttributes('paragraph').styleName as string) || 'p'),
      size: (e.getAttributes('textStyle').fontSize as string) || '',
      family: (e.getAttributes('textStyle').fontFamily as string) || '',
      lineHeight: (e.getAttributes('paragraph').lineHeight as string) || '',
      firstLine: !!e.getAttributes('paragraph').firstLine,
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      table: e.isActive('table'),
    }),
  });
  const c = () => editor.chain().focus();
  const setStyle = (id: string) => {
    const ch = c();
    if (s.style === 'quote' && id !== 'quote') ch.lift('blockquote');
    if (id === 'h1' || id === 'h2' || id === 'h3') return ch.setNode('heading', { level: Number(id[1]) }).run();
    if (id === 'quote') return ch.setParagraph().setBlockquote().run();
    if (id === 'code') return ch.toggleCodeBlock().run();
    ch.setParagraph()
      .updateAttributes('paragraph', { styleName: id === 'p' ? null : id, textAlign: id === 'title' || id === 'subtitle' || id === 'caption' ? 'center' : null })
      .run();
  };
  const B = ({ on, title, onClick, children, disabled }: { on?: boolean; title: string; onClick: () => void; children: React.ReactNode; disabled?: boolean }) => (
    <button className={`rb ${on ? 'on' : ''}`} title={title} aria-label={title} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {children}
    </button>
  );
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="wr-ribbon" role="toolbar">
      <B title="Undo (Ctrl+Z)" disabled={!s.canUndo} onClick={() => c().undo().run()}>↶</B>
      <B title="Redo (Ctrl+Y)" disabled={!s.canRedo} onClick={() => c().redo().run()}>↷</B>
      <span className="rsep" />
      <select className="rsel wide" title="Paragraph style" value={s.style} onChange={(e) => setStyle(e.target.value)}>
        {STYLE_OPTIONS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className="rsel"
        title="Font (selection, or document default)"
        value={s.family || doc.font}
        onChange={(e) => (editor.state.selection.empty ? onFont(e.target.value) : c().setFontFamily(e.target.value).run())}
      >
        {FONTS.map((f) => (
          <option key={f} value={f} style={{ fontFamily: f }}>
            {f}
          </option>
        ))}
      </select>
      <select className="rsel narrow" title="Font size" value={s.size} onChange={(e) => (e.target.value ? c().setFontSize(e.target.value).run() : c().unsetFontSize().run())}>
        <option value="">Size</option>
        {SIZES.map((z) => (
          <option key={z} value={z}>
            {z.replace('pt', '')}
          </option>
        ))}
      </select>
      <span className="rsep" />
      <B title="Bold (Ctrl+B)" on={s.bold} onClick={() => c().toggleBold().run()}><b>B</b></B>
      <B title="Italic (Ctrl+I)" on={s.italic} onClick={() => c().toggleItalic().run()}><i>I</i></B>
      <B title="Underline (Ctrl+U)" on={s.underline} onClick={() => c().toggleUnderline().run()}><u>U</u></B>
      <B title="Strikethrough" on={s.strike} onClick={() => c().toggleStrike().run()}><s>S</s></B>
      <B title="Subscript" on={s.sub} onClick={() => c().toggleSubscript().run()}>x₂</B>
      <B title="Superscript" on={s.sup} onClick={() => c().toggleSuperscript().run()}>x²</B>
      <B title="Highlight" on={s.hl} onClick={() => c().toggleHighlight({ color: '#fff176' }).run()}>🖍</B>
      <label className="rb color" title="Text colour">
        A
        <input type="color" onChange={(e) => c().setColor(e.target.value).run()} />
      </label>
      <B title="Clear formatting" onClick={() => c().unsetAllMarks().run()}>⌫</B>
      <span className="rsep" />
      {(['left', 'center', 'right', 'justify'] as const).map((a) => (
        <B key={a} title={`Align ${a}`} on={s.align === a} onClick={() => c().setTextAlign(a).run()}>
          {{ left: '⯇', center: '≡', right: '⯈', justify: '☰' }[a]}
        </B>
      ))}
      <span className="rsep" />
      <B title="Bulleted list" on={s.bullet} onClick={() => c().toggleBulletList().run()}>•≡</B>
      <B title="Numbered list" on={s.ordered} onClick={() => c().toggleOrderedList().run()}>1≡</B>
      <B title="Checklist" on={s.task} onClick={() => c().toggleTaskList().run()}>☑</B>
      <B title="Decrease indent (Shift+Tab)" onClick={() => (editor.isActive('listItem') ? c().liftListItem('listItem').run() : (c() as unknown as { outdent(): { run(): void } }).outdent().run())}>⇤</B>
      <B title="Increase indent (Tab)" onClick={() => (editor.isActive('listItem') ? c().sinkListItem('listItem').run() : (c() as unknown as { indent(): { run(): void } }).indent().run())}>⇥</B>
      <B title="First-line indent" on={s.firstLine} onClick={() => c().updateAttributes('paragraph', { firstLine: !s.firstLine }).run()}>¶→</B>
      <select className="rsel narrow" title="Line spacing" value={s.lineHeight} onChange={(e) => c().updateAttributes('paragraph', { lineHeight: e.target.value || null }).updateAttributes('heading', { lineHeight: e.target.value || null }).run()}>
        <option value="">Spacing</option>
        {['1', '1.15', '1.5', '2', '2.5'].map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
      <span className="rsep" />
      <B title="Cite a source (Ctrl+Shift+C)" onClick={onCite}>❝ Cite</B>
      <B title="Insert reference list" onClick={() => c().insertContent({ type: 'bibliography' }).run()}>📑</B>
      <B title="Clip selection from the web page (with citation)" onClick={onClip}>✂ Clip</B>
      <B title="Inline equation" onClick={() => c().insertContent({ type: 'mathInline', attrs: { latex: '' } }).run()}>∑</B>
      <B title="Equation block" onClick={() => c().insertContent({ type: 'mathBlock', attrs: { latex: '' } }).run()}>∫</B>
      <B title="Insert table" onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>▦</B>
      {s.table && (
        <>
          <B title="Add row" onClick={() => c().addRowAfter().run()}>+R</B>
          <B title="Add column" onClick={() => c().addColumnAfter().run()}>+C</B>
          <B title="Delete row" onClick={() => c().deleteRow().run()}>−R</B>
          <B title="Delete column" onClick={() => c().deleteColumn().run()}>−C</B>
          <B title="Delete table" onClick={() => c().deleteTable().run()}>✕▦</B>
        </>
      )}
      <B title="Insert image" onClick={() => fileRef.current?.click()}>🖼</B>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const r = new FileReader();
          r.onload = () => c().setImage({ src: String(r.result), alt: f.name }).run();
          r.readAsDataURL(f);
          e.target.value = '';
        }}
      />
      <LinkButton editor={editor} />
      <B title="Page break" onClick={() => c().insertContent({ type: 'pageBreak' }).run()}>⤓</B>
      <B title="Horizontal line" onClick={() => c().setHorizontalRule().run()}>―</B>
      <B title="Find and replace (Ctrl+F)" onClick={onFind}>🔍</B>
    </div>
  );
}

// ---------------------------------------------------------------------------- Find & replace

function FindReplace({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [r, setR] = useState('');
  const [caseS, setCase] = useState(false);
  const matches = useMemo(() => {
    const out: { from: number; to: number }[] = [];
    if (!q) return out;
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseS ? 'g' : 'gi');
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText) return;
      for (const m of (node.text ?? '').matchAll(re)) out.push({ from: pos + (m.index ?? 0), to: pos + (m.index ?? 0) + m[0].length });
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, caseS, editor.state.doc]);
  const [i, setI] = useState(0);
  const go = (k: number) => {
    if (!matches.length) return;
    const idx = (k + matches.length) % matches.length;
    setI(idx);
    editor.chain().focus().setTextSelection(matches[idx]).scrollIntoView().run();
  };
  const replaceAll = () => {
    const tr = editor.state.tr;
    for (const m of [...matches].reverse()) tr.insertText(r, m.from, m.to);
    editor.view.dispatch(tr);
  };
  return (
    <div className="wr-find">
      <input className="wb-input" autoFocus placeholder="Find" value={q} onChange={(e) => (setQ(e.target.value), setI(0))} onKeyDown={(e) => e.key === 'Enter' && go(e.shiftKey ? i - 1 : i + 1)} />
      <span className="muted small">{matches.length ? `${i + 1}/${matches.length}` : '0'}</span>
      <button className="wb-icon" onClick={() => go(i - 1)}>↑</button>
      <button className="wb-icon" onClick={() => go(i + 1)}>↓</button>
      <input className="wb-input" placeholder="Replace with" value={r} onChange={(e) => setR(e.target.value)} />
      <button className="wb-btn" disabled={!matches.length} onClick={() => matches[i] && (editor.chain().focus().insertContentAt(matches[i], r).run(), go(i))}>
        Replace
      </button>
      <button className="wb-btn" disabled={!matches.length} onClick={replaceAll}>
        Replace all
      </button>
      <label className="small">
        <input type="checkbox" checked={caseS} onChange={(e) => setCase(e.target.checked)} /> Match case
      </label>
      <span className="grow" />
      <button className="wb-icon" onClick={onClose}>✕</button>
    </div>
  );
}

// ---------------------------------------------------------------------------- Panes

function jumpTo(editor: Editor, blockIndex?: number, quote?: string) {
  if (blockIndex === undefined) return;
  let pos = 0;
  editor.state.doc.forEach((node, offset, index) => {
    if (index === blockIndex) {
      pos = offset + 1;
      if (quote) {
        const t = node.textContent.indexOf(quote.slice(0, 40));
        if (t >= 0) {
          let acc = 0;
          node.descendants((n, p) => {
            if (n.isText && acc <= t && t < acc + (n.text?.length ?? 0)) {
              pos = offset + 1 + p + (t - acc);
              editor.chain().focus().setTextSelection({ from: pos, to: Math.min(pos + quote.length, offset + node.nodeSize - 1) }).scrollIntoView().run();
              pos = -1;
              return false;
            }
            if (n.isText) acc += n.text?.length ?? 0;
            return true;
          });
        }
      }
    }
  });
  if (pos > 0) editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
}

function OutlinePane({ doc, editor }: { doc: PMNode; editor: Editor }) {
  const items = outline(doc);
  if (!items.length) return <p className="muted small">Add headings (Heading 1–3) to build an outline. Click a heading to jump to it.</p>;
  return (
    <ul className="wr-outline">
      {items.map((o) => (
        <li key={o.index} style={{ paddingLeft: (o.level - 1) * 14 }} onClick={() => jumpTo(editor, o.index)}>
          <span className="ellipsis">{o.text}</span>
          <small className="muted">{o.words}</small>
        </li>
      ))}
    </ul>
  );
}

const CAT_LABEL: Record<string, string> = { structure: 'Structure', evidence: 'Evidence', clarity: 'Clarity', style: 'Style', formatting: 'Formatting', next: 'What to do next' };

function ReviewPane({ doc, kind, editor, api }: { doc: PMNode; kind: string; editor: Editor; api: WorkbenchAppApi }) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [ai, setAi] = useState<{ busy?: boolean; text?: string; error?: string } | null>(null);
  const list = useMemo(() => recommend(doc, { kind: kind as never }), [doc, kind]);
  const visible = list.filter((s) => !dismissed.has(s.message));
  const groups = new Map<string, Suggestion[]>();
  for (const s of visible) groups.set(s.category, [...(groups.get(s.category) ?? []), s]);
  const askAi = async () => {
    setAi({ busy: true });
    try {
      const r = await api.invokeModule<{ ok: boolean; result?: { text?: string }; message?: string; kind?: string }>('research', 'ai.run', { task: 'claims', text: editor.getText().slice(0, 60000) });
      if (r.ok) setAi({ text: r.result?.text ?? JSON.stringify(r.result) });
      else setAi({ error: r.kind === 'consent-required' ? 'Allow “draft” access for your AI provider in the Assistant panel first.' : r.message || 'AI is off. Turn it on in the Assistant panel (Research Pack) or configure a local Ollama model.' });
    } catch (e) {
      setAi({ error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="wr-review">
      <p className="small muted">
        {visible.length ? `${visible.length} suggestion${visible.length === 1 ? '' : 's'}` : 'No suggestions — nice work.'} Updated as you type, offline. Click one to jump to it.
      </p>
      {[...groups].map(([cat, items]) => (
        <section key={cat}>
          <h5>{CAT_LABEL[cat] ?? cat}</h5>
          {items.map((s) => (
            <div key={s.id} className={`wr-sug ${s.severity}`} onClick={() => jumpTo(editor, s.block, s.quote)}>
              <div className="row">
                <b className="grow">{s.message}</b>
                <button
                  className="wb-icon small"
                  title="Dismiss"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDismissed(new Set([...dismissed, s.message]));
                  }}
                >
                  ✕
                </button>
              </div>
              {s.quote && s.quote.length > 8 && <q className="small">{s.quote}</q>}
              {s.fix && <p className="small muted">{s.fix}</p>}
            </div>
          ))}
        </section>
      ))}
      <section>
        <h5>AI reviewer (optional)</h5>
        <p className="small muted">Sends the draft to the AI provider you configured (local Ollama or your own key) and lists claims that need sources. Off unless you enable AI.</p>
        <button className="wb-btn" disabled={ai?.busy} onClick={() => void askAi()}>
          {ai?.busy ? 'Reviewing…' : 'Check claims with AI'}
        </button>
        {ai?.error && <p className="small danger">{ai.error}</p>}
        {ai?.text && <pre className="wr-ai-out">{ai.text}</pre>}
      </section>
    </div>
  );
}

function AiCheckPane({ editor }: { editor: Editor }) {
  const [res, setRes] = useState<AiCheckResult | null>(null);
  const [scope, setScope] = useState<'doc' | 'sel'>('doc');
  const run = () => {
    const { from, to, empty } = editor.state.selection;
    const text = scope === 'sel' && !empty ? editor.state.doc.textBetween(from, to, '\n') : editor.getText({ blockSeparator: '\n' });
    setRes(aiCheck(text));
  };
  return (
    <div className="wr-aicheck">
      <p className="small muted">An offline writing-style indicator: how much the text shows patterns common in AI-generated prose. It is not proof either way.</p>
      <div className="row">
        <select className="wb-select" value={scope} onChange={(e) => setScope(e.target.value as 'doc' | 'sel')}>
          <option value="doc">Whole document</option>
          <option value="sel">Selection</option>
        </select>
        <button className="wb-btn primary" onClick={run}>
          Analyse
        </button>
      </div>
      {res && res.score === null && <p className="small">Select or write at least 80 words (4+ sentences) for a meaningful estimate.</p>}
      {res && res.score !== null && (
        <>
          <div className={`wr-gauge ${res.band}`}>
            <div className="wr-gauge-bar">
              <span style={{ width: `${res.score}%` }} />
            </div>
            <b>{res.score}/100</b>
            <span>{res.band === 'high' ? 'Many machine-like patterns' : res.band === 'mixed' ? 'Some machine-like patterns' : 'Few machine-like patterns'}</span>
          </div>
          <table className="wr-signals">
            <tbody>
              {res.signals.map((s) => (
                <tr key={s.id}>
                  <td>{s.label}</td>
                  <td>
                    <span className="wr-mini">
                      <span style={{ width: `${Math.round(s.score * 100)}%` }} />
                    </span>
                  </td>
                  <td className="small muted">{s.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!!res.flagged.length && (
            <>
              <h5>Sentences with stock phrasing</h5>
              {res.flagged.slice(0, 12).map((f, i) => (
                <div key={i} className="wr-flag small">
                  {f.sentence.slice(0, 220)} <em className="muted">({f.phrases.join(', ')})</em>
                </div>
              ))}
            </>
          )}
          <p className="small muted wr-disclaimer">{res.disclaimer}</p>
        </>
      )}
    </div>
  );
}

function SourcesPane({ api, lib, reload, onCite, used }: { api: WorkbenchAppApi; lib: Map<string, Reference>; reload: () => void; onCite: (id: string) => void; used: string[] }) {
  const [q, setQ] = useState('');
  const [bibtex, setBibtex] = useState('');
  const [doi, setDoi] = useState('');
  const [msg, setMsg] = useState('');
  const refs = [...lib.values()].filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));
  const importBib = async () => {
    try {
      const r = await api.invokeModule<{ added: string[]; errors: unknown[] }>('research', 'library.import', { format: bibtex.trim().startsWith('TY  -') ? 'ris' : 'bibtex', text: bibtex });
      setMsg(`Added ${r.added.length} reference(s).`);
      setBibtex('');
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const lookup = async () => {
    try {
      await api.invokeModule('research', 'library.lookup', { identifier: doi });
      setMsg('Added.');
      setDoi('');
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  const captureTab = async () => {
    try {
      await api.invokeModule('research', 'library.captureTab', {});
      setMsg('Added the current web page.');
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="wr-sources">
      <div className="row">
        <input className="wb-input grow" placeholder={`Search ${lib.size} references`} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="wb-btn" title="Add the page open in the browser" onClick={() => void captureTab()}>
          + Page
        </button>
      </div>
      {refs.map((r) => (
        <div key={r.id} className="wr-ref">
          <div className="grow">
            <b className="small">{r.title ?? r.id}</b>
            <div className="small muted">
              {(r.author ?? []).slice(0, 3).map((a) => a.family ?? a.literal).join(', ')}
              {(r.author?.length ?? 0) > 3 ? ' et al.' : ''} · {r.issued?.['date-parts']?.[0]?.[0] ?? 'n.d.'} {used.includes(r.id) ? '· cited' : ''}
            </div>
          </div>
          <button className="wb-btn small" onClick={() => onCite(r.id)}>
            Cite
          </button>
        </div>
      ))}
      <h5>Add references</h5>
      <div className="row">
        <input className="wb-input grow" placeholder="DOI, arXiv ID or ISBN" value={doi} onChange={(e) => setDoi(e.target.value)} />
        <button className="wb-btn" disabled={!doi} onClick={() => void lookup()}>
          Look up
        </button>
      </div>
      <textarea className="wb-input" rows={4} placeholder="…or paste BibTeX / RIS" value={bibtex} onChange={(e) => setBibtex(e.target.value)} />
      <button className="wb-btn" disabled={!bibtex.trim()} onClick={() => void importBib()}>
        Import
      </button>
      {msg && <p className="small muted">{msg}</p>}
    </div>
  );
}

function VersionsPane({ api, id, onRestore }: { api: WorkbenchAppApi; id: string; onRestore: (d: WriterDoc) => void }) {
  const [list, setList] = useState<{ id: number; label: string; words: number; createdAt: number }[]>([]);
  const [label, setLabel] = useState('');
  const load = useCallback(() => void api.invoke<typeof list>('versions', { id }).then(setList), [api, id]);
  useEffect(load, [load]);
  return (
    <div className="wr-versions">
      <div className="row">
        <input className="wb-input grow" placeholder="Version name (e.g. Draft for guide)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button className="wb-btn" onClick={() => void api.invoke('snapshot', { id, label: label || 'Manual save' }).then(() => (setLabel(''), load()))}>
          Save version
        </button>
      </div>
      {!list.length && <p className="small muted">No versions yet. Ctrl+S also saves one.</p>}
      {list.map((v) => (
        <div key={v.id} className="list-row">
          <div className="grow">
            <b className="small">{v.label}</b>
            <div className="small muted">
              {new Date(v.createdAt).toLocaleString()} · {v.words} words
            </div>
          </div>
          <button
            className="wb-btn small"
            onClick={() =>
              confirm('Restore this version? Your current text is saved as a version first.') &&
              void api.invoke<WriterDoc>('restore', { id, versionId: v.id }).then((d) => (d && onRestore(d), load()))
            }
          >
            Restore
          </button>
        </div>
      ))}
    </div>
  );
}

function CitePicker({ lib, initial, onPick, onClose }: { lib: Map<string, Reference>; initial: string[]; onPick: (ids: string[]) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>(initial);
  const refs = [...lib.values()].filter((r) => !q || `${r.id} ${r.title} ${(r.author ?? []).map((a) => a.family).join(' ')}`.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
  return (
    <div className="wb-modal-back" onClick={onClose}>
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Cite sources</h3>
        <input className="wb-input" autoFocus placeholder="Search your library" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sel.length && onPick(sel)} />
        {!lib.size && <p className="small muted">Your library is empty. Add references in the Sources tab (DOI, BibTeX, or the page you are reading).</p>}
        <div className="wr-picker-list">
          {refs.map((r) => (
            <label key={r.id} className="wr-ref">
              <input type="checkbox" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} />
              <div className="grow">
                <b className="small">{r.title ?? r.id}</b>
                <div className="small muted">
                  {(r.author ?? []).slice(0, 2).map((a) => a.family ?? a.literal).join(', ')} · {r.issued?.['date-parts']?.[0]?.[0] ?? 'n.d.'}
                </div>
              </div>
            </label>
          ))}
        </div>
        <div className="row">
          <span className="grow small muted">{sel.length} selected</span>
          <button className="wb-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="wb-btn primary" disabled={!sel.length} onClick={() => onPick(sel)}>
            Insert citation
          </button>
        </div>
      </div>
    </div>
  );
}

function LinkButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState('');
  const apply = () => {
    if (href.trim()) editor.chain().focus().extendMarkRange('link').setLink({ href: /^[a-z]+:/i.test(href) ? href.trim() : `https://${href.trim()}` }).run();
    else editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setOpen(false);
  };
  return (
    <span className="wb-menu-wrap">
      <button className="rb" title="Link" onMouseDown={(e) => e.preventDefault()} onClick={() => (setHref((editor.getAttributes('link').href as string) ?? ''), setOpen(!open))}>
        🔗
      </button>
      {open && (
        <div className="wb-menu pad">
          <input className="wb-input" autoFocus placeholder="https://… (empty removes)" value={href} onChange={(e) => setHref(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? apply() : e.key === 'Escape' && setOpen(false))} />
          <button className="wb-btn small" onClick={apply}>Apply</button>
        </div>
      )}
    </span>
  );
}
