/**
 * Dimensional unit conversion with SI prefixes and compound units
 * ("km/h", "kg*m/s^2", "N·m", "mA*h"). Temperatures are affine and only
 * convert as standalone units.
 */

// Dimension vector: [m, kg, s, A, K, mol, cd, bit, rad]
type Dim = [number, number, number, number, number, number, number, number, number];
const D = (m = 0, kg = 0, s = 0, A = 0, K = 0, mol = 0, cd = 0, bit = 0, rad = 0): Dim => [m, kg, s, A, K, mol, cd, bit, rad];

interface UnitDef {
  factor: number;
  dim: Dim;
  /** Accepts SI prefixes (k, m, µ, ...). */
  prefixable?: boolean;
  /** Affine offset in kelvin, for °C/°F. */
  offset?: number;
  label: string;
}

const U: Record<string, UnitDef> = {
  // Length
  m: { factor: 1, dim: D(1), prefixable: true, label: "metre" },
  in: { factor: 0.0254, dim: D(1), label: "inch" },
  ft: { factor: 0.3048, dim: D(1), label: "foot" },
  yd: { factor: 0.9144, dim: D(1), label: "yard" },
  mi: { factor: 1609.344, dim: D(1), label: "mile" },
  nmi: { factor: 1852, dim: D(1), label: "nautical mile" },
  mil: { factor: 2.54e-5, dim: D(1), label: "mil (thou)" },
  au: { factor: 1.495_978_707e11, dim: D(1), label: "astronomical unit" },
  // Mass
  g: { factor: 1e-3, dim: D(0, 1), prefixable: true, label: "gram" },
  t: { factor: 1000, dim: D(0, 1), label: "tonne" },
  lb: { factor: 0.453_592_37, dim: D(0, 1), label: "pound" },
  oz: { factor: 0.028_349_523_125, dim: D(0, 1), label: "ounce" },
  // Time
  s: { factor: 1, dim: D(0, 0, 1), prefixable: true, label: "second" },
  min: { factor: 60, dim: D(0, 0, 1), label: "minute" },
  h: { factor: 3600, dim: D(0, 0, 1), label: "hour" },
  day: { factor: 86400, dim: D(0, 0, 1), label: "day" },
  week: { factor: 604800, dim: D(0, 0, 1), label: "week" },
  yr: { factor: 31_557_600, dim: D(0, 0, 1), label: "Julian year" },
  // Electrical
  A: { factor: 1, dim: D(0, 0, 0, 1), prefixable: true, label: "ampere" },
  V: { factor: 1, dim: D(2, 1, -3, -1), prefixable: true, label: "volt" },
  "Ω": { factor: 1, dim: D(2, 1, -3, -2), prefixable: true, label: "ohm" },
  ohm: { factor: 1, dim: D(2, 1, -3, -2), prefixable: true, label: "ohm" },
  S: { factor: 1, dim: D(-2, -1, 3, 2), prefixable: true, label: "siemens" },
  F: { factor: 1, dim: D(-2, -1, 4, 2), prefixable: true, label: "farad" },
  H: { factor: 1, dim: D(2, 1, -2, -2), prefixable: true, label: "henry" },
  C: { factor: 1, dim: D(0, 0, 1, 1), prefixable: true, label: "coulomb" },
  Ah: { factor: 3600, dim: D(0, 0, 1, 1), prefixable: true, label: "ampere-hour" },
  W: { factor: 1, dim: D(2, 1, -3), prefixable: true, label: "watt" },
  Wh: { factor: 3600, dim: D(2, 1, -2), prefixable: true, label: "watt-hour" },
  T: { factor: 1, dim: D(0, 1, -2, -1), prefixable: true, label: "tesla" },
  Wb: { factor: 1, dim: D(2, 1, -2, -1), prefixable: true, label: "weber" },
  // Mechanics
  N: { factor: 1, dim: D(1, 1, -2), prefixable: true, label: "newton" },
  lbf: { factor: 4.448_221_615_260_5, dim: D(1, 1, -2), label: "pound-force" },
  kgf: { factor: 9.806_65, dim: D(1, 1, -2), label: "kilogram-force" },
  J: { factor: 1, dim: D(2, 1, -2), prefixable: true, label: "joule" },
  cal: { factor: 4.184, dim: D(2, 1, -2), prefixable: true, label: "calorie" },
  eV: { factor: 1.602_176_634e-19, dim: D(2, 1, -2), prefixable: true, label: "electronvolt" },
  BTU: { factor: 1055.06, dim: D(2, 1, -2), label: "British thermal unit" },
  hp: { factor: 745.699_872, dim: D(2, 1, -3), label: "horsepower (mechanical)" },
  Pa: { factor: 1, dim: D(-1, 1, -2), prefixable: true, label: "pascal" },
  bar: { factor: 1e5, dim: D(-1, 1, -2), prefixable: true, label: "bar" },
  atm: { factor: 101_325, dim: D(-1, 1, -2), label: "atmosphere" },
  psi: { factor: 6894.757_293, dim: D(-1, 1, -2), label: "pound per square inch" },
  mmHg: { factor: 133.322_387, dim: D(-1, 1, -2), label: "millimetre of mercury" },
  inHg: { factor: 3386.389, dim: D(-1, 1, -2), label: "inch of mercury" },
  Hz: { factor: 1, dim: D(0, 0, -1), prefixable: true, label: "hertz" },
  rpm: { factor: 1 / 60, dim: D(0, 0, -1), label: "revolutions per minute" },
  kn: { factor: 1852 / 3600, dim: D(1, 0, -1), label: "knot" },
  mph: { factor: 0.447_04, dim: D(1, 0, -1), label: "mile per hour" },
  L: { factor: 1e-3, dim: D(3), prefixable: true, label: "litre" },
  gal: { factor: 3.785_411_784e-3, dim: D(3), label: "US gallon" },
  ha: { factor: 1e4, dim: D(2), label: "hectare" },
  acre: { factor: 4046.856_422_4, dim: D(2), label: "acre" },
  // Temperature (absolute scales used inside compounds; offsets for standalone)
  K: { factor: 1, dim: D(0, 0, 0, 0, 1), prefixable: true, label: "kelvin" },
  "°C": { factor: 1, offset: 273.15, dim: D(0, 0, 0, 0, 1), label: "degree Celsius" },
  degC: { factor: 1, offset: 273.15, dim: D(0, 0, 0, 0, 1), label: "degree Celsius" },
  "°F": { factor: 5 / 9, offset: 459.67 * (5 / 9), dim: D(0, 0, 0, 0, 1), label: "degree Fahrenheit" },
  degF: { factor: 5 / 9, offset: 459.67 * (5 / 9), dim: D(0, 0, 0, 0, 1), label: "degree Fahrenheit" },
  R: { factor: 5 / 9, dim: D(0, 0, 0, 0, 1), label: "rankine" },
  mol: { factor: 1, dim: D(0, 0, 0, 0, 0, 1), prefixable: true, label: "mole" },
  cd: { factor: 1, dim: D(0, 0, 0, 0, 0, 0, 1), label: "candela" },
  // Data
  bit: { factor: 1, dim: D(0, 0, 0, 0, 0, 0, 0, 1), prefixable: true, label: "bit" },
  b: { factor: 1, dim: D(0, 0, 0, 0, 0, 0, 0, 1), prefixable: true, label: "bit" },
  B: { factor: 8, dim: D(0, 0, 0, 0, 0, 0, 0, 1), prefixable: true, label: "byte" },
  KiB: { factor: 8 * 1024, dim: D(0, 0, 0, 0, 0, 0, 0, 1), label: "kibibyte" },
  MiB: { factor: 8 * 1024 ** 2, dim: D(0, 0, 0, 0, 0, 0, 0, 1), label: "mebibyte" },
  GiB: { factor: 8 * 1024 ** 3, dim: D(0, 0, 0, 0, 0, 0, 0, 1), label: "gibibyte" },
  TiB: { factor: 8 * 1024 ** 4, dim: D(0, 0, 0, 0, 0, 0, 0, 1), label: "tebibyte" },
  bps: { factor: 1, dim: D(0, 0, -1, 0, 0, 0, 0, 1), prefixable: true, label: "bit per second" },
  // Angle
  rad: { factor: 1, dim: D(0, 0, 0, 0, 0, 0, 0, 0, 1), prefixable: true, label: "radian" },
  deg: { factor: Math.PI / 180, dim: D(0, 0, 0, 0, 0, 0, 0, 0, 1), label: "degree" },
  "°": { factor: Math.PI / 180, dim: D(0, 0, 0, 0, 0, 0, 0, 0, 1), label: "degree" },
  rev: { factor: 2 * Math.PI, dim: D(0, 0, 0, 0, 0, 0, 0, 0, 1), label: "revolution" },
};

const PREFIX: Record<string, number> = {
  Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 10,
  d: 1e-1, c: 1e-2, m: 1e-3, u: 1e-6, "µ": 1e-6, "μ": 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18,
};

export class UnitError extends Error {
  name = "UnitError";
}

interface Parsed {
  factor: number;
  dim: Dim;
  offset?: number;
  simple: boolean;
}

function lookup(sym: string): { factor: number; def: UnitDef } {
  const direct = Object.hasOwn(U, sym) ? U[sym] : undefined;
  if (direct) return { factor: direct.factor, def: direct };
  // Longest prefix first ("da" before "d").
  for (const p of Object.keys(PREFIX).sort((a, b) => b.length - a.length)) {
    if (sym.startsWith(p)) {
      const rest = sym.slice(p.length);
      const def = Object.hasOwn(U, rest) ? U[rest] : undefined;
      if (def?.prefixable) return { factor: PREFIX[p]! * def.factor, def };
    }
  }
  throw new UnitError(`Unknown unit "${sym}"`);
}

export function parseUnit(expr: string): Parsed {
  const s = expr.trim().replace(/·|⋅/g, "*").replace(/\s+/g, "");
  if (!s) throw new UnitError("Empty unit");
  const parts = s.split(/([*/])/);
  let factor = 1;
  const dim = D();
  let offset: number | undefined;
  let count = 0;
  let op = "*";
  for (const part of parts) {
    if (part === "*" || part === "/") {
      op = part;
      continue;
    }
    if (part === "1") continue;
    const m = part.match(/^(.+?)(?:\^?(-?\d+)|([²³]))?$/);
    if (!m) throw new UnitError(`Cannot parse "${part}"`);
    const pow = (m[2] ? parseInt(m[2], 10) : m[3] === "²" ? 2 : m[3] === "³" ? 3 : 1) * (op === "/" ? -1 : 1);
    const { factor: f, def } = lookup(m[1]!);
    factor *= f ** pow;
    def.dim.forEach((d, i) => (dim[i] = dim[i]! + d * pow));
    if (def.offset !== undefined) offset = def.offset;
    count++;
  }
  const simple = count === 1 && !s.includes("/") && !/\^|[²³]/.test(s);
  return { factor, dim, offset: simple ? offset : undefined, simple };
}

export function sameDimension(a: string, b: string): boolean {
  const pa = parseUnit(a);
  const pb = parseUnit(b);
  return pa.dim.every((d, i) => Math.abs(d - pb.dim[i]!) < 1e-12);
}

/** Convert `value` from one unit expression to another. Throws UnitError on incompatible dimensions. */
export function convert(value: number, from: string, to: string): number {
  const a = parseUnit(from);
  const b = parseUnit(to);
  if (!a.dim.every((d, i) => Math.abs(d - b.dim[i]!) < 1e-12)) throw new UnitError(`Cannot convert ${from} to ${to}: incompatible dimensions`);
  const si = value * a.factor + (a.offset ?? 0);
  return (si - (b.offset ?? 0)) / b.factor;
}

/**
 * Parse a free-form conversion like "60 mph to km/h" or "3.3 kΩ in ohm"
 * (as typed into the omnibox or a calculator line).
 */
export function convertPhrase(input: string): { value: number; from: string; to: string; result: number } | undefined {
  const m = input.trim().match(/^(-?[\d.]+(?:e[+-]?\d+)?)\s*([^\s].*?)\s+(?:to|in|as|->|=>)\s+(.+)$/i);
  if (!m) return undefined;
  const value = parseFloat(m[1]!);
  try {
    return { value, from: m[2]!, to: m[3]!, result: convert(value, m[2]!, m[3]!) };
  } catch {
    return undefined;
  }
}

export const UNIT_SYMBOLS = Object.keys(U);
export const unitLabel = (sym: string) => U[sym]?.label;
