import { createContext, useContext, useEffect, useState } from 'react';
import { Extension, Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import type { Bibliography } from '@aether/citations';

/** Paragraph/heading attributes Word users expect: indent level, first-line indent, line spacing, named style. */
export const ParagraphFormat = Extension.create({
  name: 'paragraphFormat',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading'],
        attributes: {
          indent: {
            default: 0,
            parseHTML: (el) => Math.round(parseFloat(el.style.marginLeft || '0') / 2) || 0,
            renderHTML: (a) => (a.indent ? { style: `margin-left:${a.indent * 2}em` } : {}),
          },
          firstLine: {
            default: false,
            parseHTML: (el) => !!el.style.textIndent && el.style.textIndent !== '0px',
            renderHTML: (a) => (a.firstLine ? { style: 'text-indent:2em' } : {}),
          },
          lineHeight: {
            default: null,
            parseHTML: (el) => el.style.lineHeight || null,
            renderHTML: (a) => (a.lineHeight ? { style: `line-height:${a.lineHeight}` } : {}),
          },
          styleName: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-style'),
            renderHTML: (a) => (a.styleName ? { 'data-style': a.styleName, class: `ws-${a.styleName}` } : {}),
          },
        },
      },
    ];
  },
  addCommands() {
    const change =
      (delta: number) =>
      () =>
      ({ tr, state, dispatch }: { tr: import('@tiptap/pm/state').Transaction; state: import('@tiptap/pm/state').EditorState; dispatch?: (tr: unknown) => void }) => {
        const { from, to } = state.selection;
        let changed = false;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === 'paragraph' || node.type.name === 'heading') {
            const next = Math.max(0, Math.min(8, (node.attrs.indent || 0) + delta));
            if (next !== node.attrs.indent) {
              tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
              changed = true;
            }
            return false;
          }
          return true;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      };
    return {
      indent: change(1),
      outdent: change(-1),
    } as never;
  },
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (editor.isActive('codeBlock')) return editor.commands.insertContent('    ');
        if (editor.isActive('listItem')) return editor.commands.sinkListItem('listItem');
        if (editor.isActive('taskItem')) return editor.commands.sinkListItem('taskItem');
        if (editor.isActive('table')) return editor.commands.goToNextCell();
        return (editor.commands as unknown as { indent(): boolean }).indent();
      },
      'Shift-Tab': ({ editor }) => {
        if (editor.isActive('listItem')) return editor.commands.liftListItem('listItem');
        if (editor.isActive('taskItem')) return editor.commands.liftListItem('taskItem');
        if (editor.isActive('table')) return editor.commands.goToPreviousCell();
        return (editor.commands as unknown as { outdent(): boolean }).outdent();
      },
    };
  },
});

// ---------------------------------------------------------------------------- citations

export interface CiteState {
  bib: Bibliography | null;
  version: number;
  onEdit?: (pos: number, ids: string[]) => void;
}
export const CiteContext = createContext<CiteState>({ bib: null, version: 0 });

function CitationView({ node, getPos, selected }: NodeViewProps) {
  const { bib, onEdit } = useContext(CiteContext);
  const ids = (node.attrs.ids as string[]) ?? [];
  let label = `[${ids.join(', ')}]`;
  try {
    if (bib) label = bib.cite(ids);
  } catch {
    /* unknown keys render raw */
  }
  const missing = bib ? ids.filter((i) => !bib.has(i)) : [];
  return (
    <NodeViewWrapper as="span" className={`ws-cite ${selected ? 'sel' : ''} ${missing.length ? 'missing' : ''}`} title={missing.length ? `Not in your library: ${missing.join(', ')}` : ids.join(', ')} onDoubleClick={() => onEdit?.(getPos() ?? 0, ids)}>
      {label}
    </NodeViewWrapper>
  );
}

export const Citation = Node.create({
  name: 'citation',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return { ids: { default: [] as string[], parseHTML: (el) => (el.getAttribute('data-ids') ?? '').split(',').filter(Boolean), renderHTML: (a) => ({ 'data-ids': (a.ids as string[]).join(',') }) } };
  },
  parseHTML: () => [{ tag: 'span[data-cite]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { 'data-cite': '' })],
  addNodeView: () => ReactNodeViewRenderer(CitationView),
});

function BibliographyView() {
  const { bib } = useContext(CiteContext);
  const entries = bib ? bib.entries() : [];
  return (
    <NodeViewWrapper className="ws-bib" contentEditable={false}>
      <h1>References</h1>
      {!entries.length && <p className="ws-hint-inline">Your reference list appears here as you cite sources (Ctrl+Shift+C).</p>}
      <ol className={bib?.style === 'ieee' ? 'numeric' : ''}>
        {entries.map((e) => (
          <li key={e.id}>
            {e.label && <span className="lbl">{e.label} </span>}
            <span dangerouslySetInnerHTML={{ __html: e.html }} />
          </li>
        ))}
      </ol>
    </NodeViewWrapper>
  );
}

export const BibliographyNode = Node.create({
  name: 'bibliography',
  group: 'block',
  atom: true,
  parseHTML: () => [{ tag: 'div[data-bibliography]' }],
  renderHTML: () => ['div', { 'data-bibliography': '' }],
  addNodeView: () => ReactNodeViewRenderer(BibliographyView),
});

// ---------------------------------------------------------------------------- math

let katexMod: typeof import('katex') | null = null;
function useKatex() {
  const [k, setK] = useState(katexMod);
  useEffect(() => {
    if (!k) void import('katex').then((m) => setK((katexMod = (m as unknown as { default?: typeof import('katex') }).default ?? m)));
  }, [k]);
  return k;
}

function MathView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const katex = useKatex();
  const display = node.type.name === 'mathBlock';
  const [editing, setEditing] = useState(!node.attrs.latex);
  const [val, setVal] = useState(String(node.attrs.latex ?? ''));
  let html = '';
  try {
    html = katex ? katex.renderToString(String(node.attrs.latex || '\\square'), { displayMode: display, throwOnError: false }) : String(node.attrs.latex);
  } catch {
    html = String(node.attrs.latex);
  }
  return (
    <NodeViewWrapper as={display ? 'div' : 'span'} className={`ws-math ${display ? 'block' : ''} ${selected ? 'sel' : ''}`} contentEditable={false}>
      {editing && editor.isEditable ? (
        <input
          className="ws-math-input"
          autoFocus
          value={val}
          placeholder="LaTeX, e.g. E = mc^2"
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => {
            updateAttributes({ latex: val });
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault();
              updateAttributes({ latex: val });
              setEditing(false);
              editor.commands.focus();
            }
          }}
        />
      ) : (
        <span onDoubleClick={() => setEditing(true)} title="Double-click to edit" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </NodeViewWrapper>
  );
}

const mathNode = (name: string, inline: boolean) =>
  Node.create({
    name,
    group: inline ? 'inline' : 'block',
    inline,
    atom: true,
    selectable: true,
    addAttributes: () => ({ latex: { default: '' } }),
    parseHTML: () => [{ tag: `${inline ? 'span' : 'div'}[data-math]`, getAttrs: (el) => ({ latex: (el as HTMLElement).getAttribute('data-latex') ?? '' }) }],
    renderHTML: ({ node }) => [inline ? 'span' : 'div', { 'data-math': '', 'data-latex': node.attrs.latex }],
    addNodeView: () => ReactNodeViewRenderer(MathView),
  });
export const MathInline = mathNode('mathInline', true);
export const MathBlock = mathNode('mathBlock', false);

export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  parseHTML: () => [{ tag: 'div[data-page-break]' }],
  renderHTML: () => ['div', { 'data-page-break': '', class: 'ws-pagebreak' }],
});
