/** Validate and normalise ISBN-10/13. Returns the ISBN-13 form, or undefined if invalid. */
export function normalizeIsbn(input: string): string | undefined {
  const s = input.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((acc, c, i) => acc + (c === "X" ? 10 : +c) * (10 - i), 0);
    if (sum % 11 !== 0) return undefined;
    const core = `978${s.slice(0, 9)}`;
    return core + isbn13Check(core);
  }
  if (/^97[89]\d{10}$/.test(s)) return isbn13Check(s.slice(0, 12)) === s[12] ? s : undefined;
  return undefined;
}

function isbn13Check(twelve: string): string {
  const sum = [...twelve].reduce((acc, c, i) => acc + +c * (i % 2 ? 3 : 1), 0);
  return String((10 - (sum % 10)) % 10);
}
