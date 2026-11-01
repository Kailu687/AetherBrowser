/** Languages the editor knows, how to highlight them and how to run them. */
export interface RunStep {
  /** Candidate executables, first one found wins (e.g. python, python3, py). */
  tool: string[];
  /** Arguments; {file} {dir} {out} {base} are substituted. */
  args: string[];
}

export interface LanguageDef {
  id: string;
  name: string;
  ext: string[];
  /** Name of the CodeMirror language loader (see ui/cm.ts). */
  cm: string;
  /** How code runs: 'node' = bundled runtime, 'sqlite' = in-memory database, 'preview' = open in a tab, 'local' = installed toolchain. */
  run: 'node' | 'ts' | 'sqlite' | 'preview' | 'local' | 'none';
  compile?: RunStep;
  exec?: RunStep;
  /** Where to get the toolchain. */
  install?: string;
  hello: string;
}



export const LANGUAGES: LanguageDef[] = [
  { id: 'python', name: 'Python', ext: ['py'], cm: 'python', run: 'local', exec: { tool: ['python', 'python3', 'py'], args: ['-u', '{file}'] }, install: 'https://www.python.org/downloads/', hello: 'name = input("Your name: ")\nprint(f"Hello, {name}!")\n' },
  { id: 'javascript', name: 'JavaScript (Node)', ext: ['js', 'mjs', 'cjs'], cm: 'javascript', run: 'node', hello: 'const nums = [3, 1, 4, 1, 5, 9];\nconsole.log("sorted:", nums.toSorted((a, b) => a - b));\n' },
  { id: 'typescript', name: 'TypeScript', ext: ['ts'], cm: 'typescript', run: 'ts', hello: 'interface Part { name: string; ohms: number }\nconst r: Part[] = [{ name: "R1", ohms: 1000 }, { name: "R2", ohms: 2200 }];\nconsole.log("Series:", r.reduce((a, p) => a + p.ohms, 0), "Ω");\n' },
  { id: 'c', name: 'C', ext: ['c', 'h'], cm: 'cpp', run: 'local', compile: { tool: ['gcc', 'clang'], args: ['{file}', '-O2', '-lm', '-o', '{out}{exe}'] }, exec: { tool: ['{out}{exe}'], args: [] }, install: 'https://www.msys2.org/', hello: '#include <stdio.h>\n\nint main(void) {\n    printf("Hello from C\\n");\n    return 0;\n}\n' },
  { id: 'cpp', name: 'C++', ext: ['cpp', 'cc', 'cxx', 'hpp'], cm: 'cpp', run: 'local', compile: { tool: ['g++', 'clang++'], args: ['{file}', '-std=c++17', '-O2', '-o', '{out}{exe}'] }, exec: { tool: ['{out}{exe}'], args: [] }, install: 'https://www.msys2.org/', hello: '#include <iostream>\n#include <vector>\n\nint main() {\n    std::vector<int> v{1, 2, 3};\n    for (int x : v) std::cout << x * x << " ";\n    std::cout << "\\n";\n}\n' },
  { id: 'java', name: 'Java', ext: ['java'], cm: 'java', run: 'local', exec: { tool: ['java'], args: ['{file}'] }, install: 'https://adoptium.net/', hello: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello from Java");\n    }\n}\n' },
  { id: 'go', name: 'Go', ext: ['go'], cm: 'go', run: 'local', exec: { tool: ['go'], args: ['run', '{file}'] }, install: 'https://go.dev/dl/', hello: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello from Go")\n}\n' },
  { id: 'rust', name: 'Rust', ext: ['rs'], cm: 'rust', run: 'local', compile: { tool: ['rustc'], args: ['{file}', '-O', '-o', '{out}{exe}'] }, exec: { tool: ['{out}{exe}'], args: [] }, install: 'https://rustup.rs/', hello: 'fn main() {\n    let v: Vec<u32> = (1..=5).map(|x| x * x).collect();\n    println!("{:?}", v);\n}\n' },
  { id: 'csharp', name: 'C#', ext: ['cs', 'csx'], cm: 'java', run: 'local', exec: { tool: ['dotnet'], args: ['run', '{file}'] }, install: 'https://dotnet.microsoft.com/download', hello: 'Console.WriteLine("Hello from C#");\n' },
  { id: 'kotlin', name: 'Kotlin (script)', ext: ['kts'], cm: 'java', run: 'local', exec: { tool: ['kotlinc', 'kotlinc.bat'], args: ['-script', '{file}'] }, install: 'https://kotlinlang.org/docs/command-line.html', hello: 'println("Hello from Kotlin")\n' },
  { id: 'php', name: 'PHP', ext: ['php'], cm: 'php', run: 'local', exec: { tool: ['php'], args: ['{file}'] }, install: 'https://windows.php.net/download/', hello: '<?php\necho "Hello from PHP\\n";\n' },
  { id: 'ruby', name: 'Ruby', ext: ['rb'], cm: 'ruby', run: 'local', exec: { tool: ['ruby'], args: ['{file}'] }, install: 'https://rubyinstaller.org/', hello: 'puts "Hello from Ruby"\n' },
  { id: 'lua', name: 'Lua', ext: ['lua'], cm: 'lua', run: 'local', exec: { tool: ['lua', 'lua54', 'luajit'], args: ['{file}'] }, install: 'https://luabinaries.sourceforge.net/', hello: 'print("Hello from Lua")\n' },
  { id: 'r', name: 'R', ext: ['r', 'R'], cm: 'r', run: 'local', exec: { tool: ['Rscript'], args: ['{file}'] }, install: 'https://cran.r-project.org/', hello: 'x <- c(2, 4, 4, 5)\ncat("mean:", mean(x), "sd:", sd(x), "\\n")\n' },
  { id: 'julia', name: 'Julia', ext: ['jl'], cm: 'julia', run: 'local', exec: { tool: ['julia'], args: ['{file}'] }, install: 'https://julialang.org/downloads/', hello: 'println("Hello from Julia")\n' },
  { id: 'dart', name: 'Dart', ext: ['dart'], cm: 'java', run: 'local', exec: { tool: ['dart'], args: ['run', '{file}'] }, install: 'https://dart.dev/get-dart', hello: 'void main() {\n  print("Hello from Dart");\n}\n' },
  { id: 'bash', name: 'Shell (bash)', ext: ['sh'], cm: 'shell', run: 'local', exec: { tool: ['bash'], args: ['{file}'] }, install: 'https://git-scm.com/download/win', hello: 'echo "Hello from bash"\n' },
  { id: 'powershell', name: 'PowerShell', ext: ['ps1'], cm: 'powershell', run: 'local', exec: { tool: ['pwsh', 'powershell'], args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '{file}'] }, hello: 'Write-Output "Hello from PowerShell"\n' },
  { id: 'matlab', name: 'Octave / MATLAB', ext: ['m'], cm: 'octave', run: 'local', exec: { tool: ['octave-cli', 'octave'], args: ['--no-gui', '-q', '{file}'] }, install: 'https://octave.org/download', hello: 'x = linspace(0, 1, 5);\ndisp(x .^ 2)\n' },
  { id: 'sql', name: 'SQL (SQLite)', ext: ['sql'], cm: 'sql', run: 'sqlite', hello: 'CREATE TABLE parts (name TEXT, qty INT, price REAL);\nINSERT INTO parts VALUES (\'LM317\', 10, 0.45), (\'NE555\', 25, 0.2);\nSELECT name, qty * price AS total FROM parts ORDER BY total DESC;\n' },
  { id: 'html', name: 'HTML', ext: ['html', 'htm'], cm: 'html', run: 'preview', hello: '<!doctype html>\n<html>\n  <body>\n    <h1>Hello</h1>\n    <button onclick="this.textContent = Date()">What time is it?</button>\n  </body>\n</html>\n' },
  { id: 'css', name: 'CSS', ext: ['css'], cm: 'css', run: 'none', hello: 'body { font-family: system-ui; }\n' },
  { id: 'json', name: 'JSON', ext: ['json'], cm: 'json', run: 'none', hello: '{\n  "hello": "world"\n}\n' },
  { id: 'markdown', name: 'Markdown', ext: ['md'], cm: 'markdown', run: 'none', hello: '# Notes\n\n- item\n' },
  { id: 'xml', name: 'XML', ext: ['xml', 'svg'], cm: 'xml', run: 'none', hello: '<root/>\n' },
  { id: 'yaml', name: 'YAML', ext: ['yml', 'yaml'], cm: 'yaml', run: 'none', hello: 'key: value\n' },
  { id: 'text', name: 'Plain text', ext: ['txt'], cm: 'text', run: 'none', hello: '' },
];

export const languageById = (id: string) => LANGUAGES.find((l) => l.id === id);
export function languageForFile(name: string): LanguageDef {
  const ext = name.split('.').pop() ?? '';
  return LANGUAGES.find((l) => l.ext.includes(ext)) ?? LANGUAGES.find((l) => l.ext.includes(ext.toLowerCase())) ?? languageById('text')!;
}

/** Java single-file launch needs the file named after its public class. */
export function suggestedFileName(lang: LanguageDef, code: string): string {
  if (lang.id === 'java') {
    const m = code.match(/public\s+(?:final\s+)?class\s+(\w+)/);
    return `${m?.[1] ?? 'Main'}.java`;
  }
  return `main.${lang.ext[0]}`;
}

export function substitute(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? ''));
}
