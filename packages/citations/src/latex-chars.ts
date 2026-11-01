/** Decode common LaTeX accent commands and escapes found in BibTeX into Unicode. */
const ACCENTS: Record<string, string> = {
  "`": "̀", "'": "́", "^": "̂", "~": "̃", "=": "̄", ".": "̇",
  '"': "̈", H: "̋", c: "̧", k: "̨", u: "̆", v: "̌", r: "̊",
};
const SYMBOLS: Record<string, string> = {
  ss: "ß", ae: "æ", AE: "Æ", oe: "œ", OE: "Œ", o: "ø", O: "Ø", aa: "å", AA: "Å", l: "ł", L: "Ł", i: "ı", j: "ȷ",
  textendash: "–", textemdash: "—", textregistered: "®", texttrademark: "™", copyright: "©",
  textbackslash: "\\", textasciitilde: "~", textunderscore: "_", textquotedblleft: "“", textquotedblright: "”",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", mu: "μ", pi: "π", sigma: "σ", omega: "ω", Omega: "Ω",
};

export function decodeLatex(input: string): string {
  let s = input;
  // {\"o}, \"{o}, \"o
  s = s.replace(/\{?\\([`'^~=."Hckuvr])\s*\{?\\?([A-Za-z])\}?\}?/g, (_, acc: string, ch: string) => {
    const base = ch === "i" ? "i" : ch;
    return (base + ACCENTS[acc]).normalize("NFC");
  });
  s = s.replace(/\{?\\([A-Za-z]+)\b\s*(\{\})?\}?/g, (m, name: string) => SYMBOLS[name] ?? m);
  s = s
    .replace(/\\([&%$#_{}])/g, "$1")
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/``/g, "“")
    .replace(/''/g, "”")
    .replace(/(?<!\\)~/g, " ");
  // Remove grouping braces used for case protection.
  s = s.replace(/(?<!\\)[{}]/g, "");
  return s.replace(/\s+/g, " ").trim();
}

const ENCODE: Array<[RegExp, string]> = [
  [/\\/g, "\\textbackslash{}"],
  [/([&%$#_])/g, "\\$1"],
  [/–/g, "--"],
  [/—/g, "---"],
];

/** Encode a Unicode string for a BibTeX field value. Non-ASCII letters are kept (biber/UTF-8). */
export function encodeLatex(s: string): string {
  let out = s;
  for (const [re, rep] of ENCODE) out = out.replace(re, rep);
  return out;
}
