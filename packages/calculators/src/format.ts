const PREFIXES: Array<[number, string]> = [
  [1e24, "Y"], [1e21, "Z"], [1e18, "E"], [1e15, "P"], [1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"],
  [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"], [1e-18, "a"], [1e-21, "z"], [1e-24, "y"],
];

/** Round to `sig` significant figures without floating-point noise. */
export function toSignificant(x: number, sig = 4): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  return Number(x.toPrecision(sig));
}

/** 4700 → "4.7 kΩ" with SI prefixes; falls back to exponent notation outside 1e-24..1e27. */
export function formatSI(x: number, unit = "", sig = 4): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "NaN" : x > 0 ? "∞" : "−∞";
  if (x === 0) return `0${unit ? ` ${unit}` : ""}`;
  const abs = Math.abs(x);
  const entry = PREFIXES.find(([f]) => abs >= f * 0.9999999);
  if (!entry || abs >= 1e27) return `${x.toExponential(sig - 1)}${unit ? ` ${unit}` : ""}`;
  const [factor, p] = entry;
  const scaled = toSignificant(x / factor, sig);
  // Rounding can push 999.96 → 1000; re-scale in that case.
  if (Math.abs(scaled) >= 1000 && factor < 1e24) return formatSI(x * 1.0000001, unit, sig);
  return `${scaled}${unit || p ? " " : ""}${p}${unit}`;
}

/** Engineering notation: exponent is a multiple of 3. 0.00047 → "470e-6". */
export function formatEngineering(x: number, sig = 4): string {
  if (x === 0 || !Number.isFinite(x)) return String(x);
  const exp = Math.floor(Math.log10(Math.abs(x)) / 3) * 3;
  const m = toSignificant(x / 10 ** exp, sig);
  return exp === 0 ? String(m) : `${m}e${exp}`;
}
