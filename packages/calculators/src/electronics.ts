/** Electronics calculators. All inputs and outputs are in base SI units (V, A, Ω, F, H, Hz, W). */

export class InputError extends Error {
  name = "InputError";
}

const need = (cond: boolean, msg: string) => {
  if (!cond) throw new InputError(msg);
};
const finite = (x: number | undefined): x is number => typeof x === "number" && Number.isFinite(x);

export interface OhmInputs {
  V?: number;
  I?: number;
  R?: number;
  P?: number;
}

/** Ohm's law and power: give any two of V, I, R, P and get all four. */
export function ohmsLaw(x: OhmInputs): Required<OhmInputs> {
  const known = (["V", "I", "R", "P"] as const).filter((k) => finite(x[k]));
  need(known.length === 2, "Provide exactly two of V, I, R, P.");
  let { V, I, R, P } = x as Record<string, number>;
  const has = (k: string) => known.includes(k as never);
  if (has("V") && has("I")) (R = V! / I!), (P = V! * I!);
  else if (has("V") && has("R")) (I = V! / R!), (P = (V! * V!) / R!);
  else if (has("V") && has("P")) (I = P! / V!), (R = (V! * V!) / P!);
  else if (has("I") && has("R")) (V = I! * R!), (P = I! * I! * R!);
  else if (has("I") && has("P")) (V = P! / I!), (R = P! / (I! * I!));
  else (V = Math.sqrt(P! * R!)), (I = Math.sqrt(P! / R!));
  return { V: V!, I: I!, R: R!, P: P! };
}

export const seriesSum = (values: number[]) => values.reduce((a, b) => a + b, 0);
export const parallelSum = (values: number[]) => {
  need(values.length > 0 && values.every((v) => v > 0), "Values must be positive.");
  return 1 / values.reduce((a, v) => a + 1 / v, 0);
};

export function voltageDivider(vin: number, r1: number, r2: number, rLoad?: number) {
  const r2eff = rLoad ? parallelSum([r2, rLoad]) : r2;
  const vout = (vin * r2eff) / (r1 + r2eff);
  return { vout, ratio: vout / vin, current: vin / (r1 + r2eff), theveninR: parallelSum([r1, r2eff]) };
}

/** First-order RC or RL: τ, −3 dB cutoff, and 10–90% rise time. */
export function rcFilter(R: number, C: number) {
  const tau = R * C;
  return { tau, fc: 1 / (2 * Math.PI * tau), riseTime: tau * Math.log(9) };
}
export function rlFilter(R: number, L: number) {
  const tau = L / R;
  return { tau, fc: R / (2 * Math.PI * L), riseTime: tau * Math.log(9) };
}

export function lcResonance(L: number, C: number, R?: number) {
  const f0 = 1 / (2 * Math.PI * Math.sqrt(L * C));
  const Z0 = Math.sqrt(L / C);
  return { f0, Z0, Q: R ? Z0 / R : undefined, bandwidth: R ? f0 / (Z0 / R) : undefined };
}

export const capacitiveReactance = (f: number, C: number) => 1 / (2 * Math.PI * f * C);
export const inductiveReactance = (f: number, L: number) => 2 * Math.PI * f * L;

/** Capacitor voltage at time t while charging from 0 towards Vs through R. */
export const rcCharge = (Vs: number, R: number, C: number, t: number) => Vs * (1 - Math.exp(-t / (R * C)));

export function ledResistor(supply: number, forwardV: number, current: number) {
  need(supply > forwardV, "Supply voltage must exceed the LED forward voltage.");
  const R = (supply - forwardV) / current;
  return { R, power: current * current * R, nearestE24: nearestPreferred(R, "E24", "up") };
}

export const opAmp = {
  inverting: (Rf: number, Rin: number) => -Rf / Rin,
  nonInverting: (Rf: number, Rg: number) => 1 + Rf / Rg,
  /** Closed-loop bandwidth given gain-bandwidth product and noise gain. */
  bandwidth: (gbw: number, noiseGain: number) => gbw / Math.abs(noiseGain),
};

export const db = {
  fromVoltageRatio: (r: number) => 20 * Math.log10(r),
  fromPowerRatio: (r: number) => 10 * Math.log10(r),
  toVoltageRatio: (d: number) => 10 ** (d / 20),
  toPowerRatio: (d: number) => 10 ** (d / 10),
  dBmToWatts: (d: number) => 10 ** (d / 10) / 1000,
  wattsTodBm: (w: number) => 10 * Math.log10(w * 1000),
};

/** NE555 astable: frequency and duty cycle. */
export function timer555Astable(R1: number, R2: number, C: number) {
  const tHigh = Math.LN2 * (R1 + R2) * C;
  const tLow = Math.LN2 * R2 * C;
  return { frequency: 1 / (tHigh + tLow), duty: tHigh / (tHigh + tLow), tHigh, tLow };
}

// ---------- Resistor colour code ----------

export const COLORS = ["black", "brown", "red", "orange", "yellow", "green", "blue", "violet", "grey", "white"] as const;
const MULTIPLIER: Record<string, number> = { ...Object.fromEntries(COLORS.map((c, i) => [c, 10 ** i])), gold: 0.1, silver: 0.01 };
const TOLERANCE: Record<string, number> = { brown: 1, red: 2, green: 0.5, blue: 0.25, violet: 0.1, grey: 0.05, gold: 5, silver: 10, none: 20 };
const TEMPCO: Record<string, number> = { black: 250, brown: 100, red: 50, orange: 15, yellow: 25, green: 20, blue: 10, violet: 5, grey: 1 };

const normColor = (c: string) => c.trim().toLowerCase().replace("gray", "grey").replace("purple", "violet");

/** Decode a 3/4/5/6-band resistor. Returns ohms, tolerance %, and tempco ppm/K (6-band). */
export function decodeResistorBands(bands: string[]) {
  const b = bands.map(normColor);
  need(b.length >= 3 && b.length <= 6, "Resistors have 3 to 6 bands.");
  const digitCount = b.length >= 5 ? 3 : 2;
  const digits = b.slice(0, digitCount).map((c) => {
    const d = COLORS.indexOf(c as (typeof COLORS)[number]);
    need(d >= 0, `"${c}" is not a digit colour.`);
    return d;
  });
  const mult = MULTIPLIER[b[digitCount]!];
  need(mult !== undefined, `"${b[digitCount]}" is not a multiplier colour.`);
  const ohms = Number((Number(digits.join("")) * mult!).toPrecision(digitCount + 1));
  const tolColor = b[digitCount + 1] ?? "none";
  const tolerance = TOLERANCE[tolColor];
  need(tolerance !== undefined, `"${tolColor}" is not a tolerance colour.`);
  const tempco = b.length === 6 ? TEMPCO[b[5]!] : undefined;
  return { ohms, tolerance: tolerance!, tempco };
}

/** Encode a resistance as colour bands (4-band for 2 significant digits, 5-band for 3). */
export function encodeResistorBands(ohms: number, tolerance = 5, bandsCount: 4 | 5 = 4): string[] {
  need(ohms > 0, "Resistance must be positive.");
  const sig = bandsCount === 5 ? 3 : 2;
  const exp = Math.floor(Math.log10(ohms)) - (sig - 1);
  const mantissa = Math.round(ohms / 10 ** exp);
  const fixedExp = mantissa >= 10 ** sig ? exp + 1 : exp;
  const m = mantissa >= 10 ** sig ? Math.round(mantissa / 10) : mantissa;
  need(fixedExp >= -2 && fixedExp <= 9, "Resistance out of colour-code range.");
  const digits = String(m).padStart(sig, "0").split("").map((d) => COLORS[+d]!);
  const multColor = fixedExp === -1 ? "gold" : fixedExp === -2 ? "silver" : COLORS[fixedExp]!;
  const tol = Object.entries(TOLERANCE).find(([, v]) => v === tolerance)?.[0];
  need(!!tol, `No colour for ${tolerance}% tolerance.`);
  return [...digits, multColor, ...(tol === "none" ? [] : [tol!])];
}

// ---------- Preferred values (IEC 60063) ----------

const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
export type ESeries = "E3" | "E6" | "E12" | "E24" | "E48" | "E96" | "E192";

export function seriesValues(series: ESeries): number[] {
  const n = parseInt(series.slice(1), 10);
  if (n <= 24) return E24.filter((_, i) => i % (24 / n) === 0);
  const vals = Array.from({ length: n }, (_, i) => Number((10 ** (i / n)).toFixed(2)));
  // The one irregular value in IEC 60063 E192.
  if (n === 192) vals[185] = 9.2;
  return vals;
}

/** Nearest preferred value; `direction` "up"/"down" picks the next value at or above/below. */
export function nearestPreferred(value: number, series: ESeries = "E24", direction: "nearest" | "up" | "down" = "nearest"): number {
  need(value > 0, "Value must be positive.");
  const decade = 10 ** Math.floor(Math.log10(value));
  const base = seriesValues(series);
  const candidates = [...base.map((v) => v * decade / 10), ...base.map((v) => v * decade), ...base.map((v) => v * decade * 10)].map((v) => Number(v.toPrecision(3)));
  if (direction === "up") return candidates.find((c) => c >= value * (1 - 1e-9)) ?? candidates[candidates.length - 1]!;
  if (direction === "down") return [...candidates].reverse().find((c) => c <= value * (1 + 1e-9)) ?? candidates[0]!;
  // Compare on a log scale, which is how series are spaced.
  return candidates.reduce((best, c) => (Math.abs(Math.log(c / value)) < Math.abs(Math.log(best / value)) ? c : best));
}

// ---------- Wire and PCB ----------

const COPPER_RESISTIVITY = 1.724e-8; // Ω·m at 20 °C (annealed copper, IACS)

/** AWG gauge → diameter (m), area (m²), resistance per metre (Ω/m) of solid copper at 20 °C. */
export function awg(gauge: number) {
  const d = 0.127e-3 * 92 ** ((36 - gauge) / 39);
  const area = (Math.PI * d * d) / 4;
  return { diameter: d, area, ohmsPerMeter: COPPER_RESISTIVITY / area };
}

/**
 * IPC-2221 trace width for a given current and temperature rise.
 * `thicknessOz` is copper weight (1 oz ≈ 35 µm). Returns width in metres.
 */
export function pcbTraceWidth(current: number, tempRise = 10, thicknessOz = 1, layer: "external" | "internal" = "external") {
  const k = layer === "external" ? 0.048 : 0.024;
  const areaMil2 = (current / (k * tempRise ** 0.44)) ** (1 / 0.725);
  const thicknessMil = thicknessOz * 1.378;
  const widthMil = areaMil2 / thicknessMil;
  return { width: widthMil * 2.54e-5, widthMil, areaMil2 };
}

/** Battery runtime estimate in hours, with a derating factor for usable capacity. */
export const batteryLife = (capacityAh: number, loadA: number, derating = 0.8) => (capacityAh * derating) / loadA;
