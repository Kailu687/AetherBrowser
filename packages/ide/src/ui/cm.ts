import type { Extension } from '@codemirror/state';

/** Lazily loads the CodeMirror language support for a language id from LANGUAGES[].cm. */
export async function loadLanguage(cm: string): Promise<Extension | null> {
  const legacy = async (name: string) => {
    const { StreamLanguage } = await import('@codemirror/language');
    const mods: Record<string, () => Promise<Record<string, unknown>>> = {
      ruby: () => import('@codemirror/legacy-modes/mode/ruby'),
      lua: () => import('@codemirror/legacy-modes/mode/lua'),
      r: () => import('@codemirror/legacy-modes/mode/r'),
      julia: () => import('@codemirror/legacy-modes/mode/julia'),
      shell: () => import('@codemirror/legacy-modes/mode/shell'),
      powershell: () => import('@codemirror/legacy-modes/mode/powershell'),
      octave: () => import('@codemirror/legacy-modes/mode/octave'),
      yaml: () => import('@codemirror/legacy-modes/mode/yaml'),
    };
    const m = await mods[name]?.();
    const parser = m && (m[name] ?? Object.values(m)[0]);
    return parser ? StreamLanguage.define(parser as never) : null;
  };
  switch (cm) {
    case 'javascript': return (await import('@codemirror/lang-javascript')).javascript();
    case 'typescript': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'python': return (await import('@codemirror/lang-python')).python();
    case 'cpp': return (await import('@codemirror/lang-cpp')).cpp();
    case 'java': return (await import('@codemirror/lang-java')).java();
    case 'rust': return (await import('@codemirror/lang-rust')).rust();
    case 'go': return (await import('@codemirror/lang-go')).go();
    case 'html': return (await import('@codemirror/lang-html')).html();
    case 'css': return (await import('@codemirror/lang-css')).css();
    case 'json': return (await import('@codemirror/lang-json')).json();
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown();
    case 'sql': return (await import('@codemirror/lang-sql')).sql();
    case 'php': return (await import('@codemirror/lang-php')).php();
    case 'xml': return (await import('@codemirror/lang-xml')).xml();
    case 'text': return null;
    default: return legacy(cm);
  }
}
