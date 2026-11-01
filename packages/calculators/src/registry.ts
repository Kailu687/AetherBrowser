import * as el from "./electronics.js";
import { aero, beams, isa } from "./mechanical.js";
import { loanEmi, percent } from "./everyday.js";

export interface Field {
  key: string;
  label: string;
  /** Display unit; values are entered and shown in this unit with SI prefixes allowed ("4.7k"). */
  unit?: string;
  default?: number;
  optional?: boolean;
}

export interface Output {
  label: string;
  value: number | string;
  unit?: string;
}

export interface CalculatorDef {
  id: string;
  title: string;
  category: "Electronics" | "Signals" | "Mechanical" | "Aerospace" | "Everyday";
  keywords: string[];
  fields: Field[];
  compute(v: Record<string, number | undefined>): Output[];
}

const num = (v: Record<string, number | undefined>, k: string) => {
  const x = v[k];
  if (x === undefined || !Number.isFinite(x)) throw new el.InputError(`Enter a value for ${k}.`);
  return x;
};

/** Declarative catalogue rendered by the generic calculator panel. */
export const CALCULATORS: CalculatorDef[] = [
  {
    id: "ohm",
    title: "Ohm's law & power",
    category: "Electronics",
    keywords: ["voltage", "current", "resistance", "power", "ohm"],
    fields: [
      { key: "V", label: "Voltage", unit: "V", optional: true },
      { key: "I", label: "Current", unit: "A", optional: true },
      { key: "R", label: "Resistance", unit: "Ω", optional: true },
      { key: "P", label: "Power", unit: "W", optional: true },
    ],
    compute: (v) => {
      const r = el.ohmsLaw(v);
      return [
        { label: "Voltage", value: r.V, unit: "V" },
        { label: "Current", value: r.I, unit: "A" },
        { label: "Resistance", value: r.R, unit: "Ω" },
        { label: "Power", value: r.P, unit: "W" },
      ];
    },
  },
  {
    id: "divider",
    title: "Voltage divider",
    category: "Electronics",
    keywords: ["divider", "resistor", "bias"],
    fields: [
      { key: "vin", label: "Vin", unit: "V", default: 5 },
      { key: "r1", label: "R1 (top)", unit: "Ω", default: 10e3 },
      { key: "r2", label: "R2 (bottom)", unit: "Ω", default: 10e3 },
      { key: "rl", label: "Load", unit: "Ω", optional: true },
    ],
    compute: (v) => {
      const r = el.voltageDivider(num(v, "vin"), num(v, "r1"), num(v, "r2"), v.rl);
      return [
        { label: "Vout", value: r.vout, unit: "V" },
        { label: "Divider current", value: r.current, unit: "A" },
        { label: "Thevenin resistance", value: r.theveninR, unit: "Ω" },
      ];
    },
  },
  {
    id: "rc",
    title: "RC filter / time constant",
    category: "Signals",
    keywords: ["rc", "low pass", "cutoff", "time constant", "filter"],
    fields: [
      { key: "R", label: "R", unit: "Ω", default: 1e3 },
      { key: "C", label: "C", unit: "F", default: 100e-9 },
    ],
    compute: (v) => {
      const r = el.rcFilter(num(v, "R"), num(v, "C"));
      return [
        { label: "τ", value: r.tau, unit: "s" },
        { label: "Cutoff (−3 dB)", value: r.fc, unit: "Hz" },
        { label: "Rise time 10–90%", value: r.riseTime, unit: "s" },
      ];
    },
  },
  {
    id: "lc",
    title: "LC resonance",
    category: "Signals",
    keywords: ["lc", "tank", "resonant", "oscillator"],
    fields: [
      { key: "L", label: "L", unit: "H", default: 10e-6 },
      { key: "C", label: "C", unit: "F", default: 100e-12 },
      { key: "R", label: "Series R", unit: "Ω", optional: true },
    ],
    compute: (v) => {
      const r = el.lcResonance(num(v, "L"), num(v, "C"), v.R);
      const out: Output[] = [
        { label: "f₀", value: r.f0, unit: "Hz" },
        { label: "Characteristic impedance", value: r.Z0, unit: "Ω" },
      ];
      if (r.Q !== undefined) out.push({ label: "Q", value: r.Q }, { label: "Bandwidth", value: r.bandwidth!, unit: "Hz" });
      return out;
    },
  },
  {
    id: "led",
    title: "LED series resistor",
    category: "Electronics",
    keywords: ["led", "resistor", "current limiting"],
    fields: [
      { key: "vs", label: "Supply", unit: "V", default: 5 },
      { key: "vf", label: "LED forward voltage", unit: "V", default: 2 },
      { key: "i", label: "LED current", unit: "A", default: 0.02 },
    ],
    compute: (v) => {
      const r = el.ledResistor(num(v, "vs"), num(v, "vf"), num(v, "i"));
      return [
        { label: "Exact resistor", value: r.R, unit: "Ω" },
        { label: "Next E24 value", value: r.nearestE24, unit: "Ω" },
        { label: "Resistor power", value: r.power, unit: "W" },
      ];
    },
  },
  {
    id: "555",
    title: "555 astable",
    category: "Signals",
    keywords: ["555", "timer", "oscillator", "pwm"],
    fields: [
      { key: "r1", label: "R1", unit: "Ω", default: 1e3 },
      { key: "r2", label: "R2", unit: "Ω", default: 10e3 },
      { key: "c", label: "C", unit: "F", default: 10e-6 },
    ],
    compute: (v) => {
      const r = el.timer555Astable(num(v, "r1"), num(v, "r2"), num(v, "c"));
      return [
        { label: "Frequency", value: r.frequency, unit: "Hz" },
        { label: "Duty cycle", value: `${(r.duty * 100).toFixed(1)} %` },
        { label: "High time", value: r.tHigh, unit: "s" },
      ];
    },
  },
  {
    id: "trace",
    title: "PCB trace width (IPC-2221)",
    category: "Electronics",
    keywords: ["pcb", "trace", "copper", "ipc"],
    fields: [
      { key: "i", label: "Current", unit: "A", default: 1 },
      { key: "dt", label: "Temperature rise", unit: "K", default: 10 },
      { key: "oz", label: "Copper weight (oz)", default: 1 },
    ],
    compute: (v) => {
      const r = el.pcbTraceWidth(num(v, "i"), num(v, "dt"), num(v, "oz"));
      const inner = el.pcbTraceWidth(num(v, "i"), num(v, "dt"), num(v, "oz"), "internal");
      return [
        { label: "External layer width", value: r.width, unit: "m" },
        { label: "External (mil)", value: Number(r.widthMil.toFixed(1)), unit: "mil" },
        { label: "Internal layer width", value: inner.width, unit: "m" },
      ];
    },
  },
  {
    id: "isa",
    title: "Standard atmosphere (ISA)",
    category: "Aerospace",
    keywords: ["atmosphere", "altitude", "density", "pressure", "isa"],
    fields: [
      { key: "h", label: "Altitude", unit: "m", default: 3000 },
      { key: "dT", label: "ISA deviation", unit: "K", default: 0 },
    ],
    compute: (v) => {
      const r = isa(num(v, "h"), v.dT ?? 0);
      return [
        { label: "Temperature", value: Number((r.temperature - 273.15).toFixed(2)), unit: "°C" },
        { label: "Pressure", value: r.pressure, unit: "Pa" },
        { label: "Density", value: Number(r.density.toPrecision(4)), unit: "kg/m³" },
        { label: "Speed of sound", value: Number(r.speedOfSound.toFixed(1)), unit: "m/s" },
      ];
    },
  },
  {
    id: "lift",
    title: "Lift, stall speed & Reynolds number",
    category: "Aerospace",
    keywords: ["lift", "wing", "stall", "reynolds", "aircraft"],
    fields: [
      { key: "m", label: "Mass", unit: "kg", default: 1100 },
      { key: "S", label: "Wing area", unit: "m²", default: 16.2 },
      { key: "clmax", label: "CLmax", default: 1.6 },
      { key: "h", label: "Altitude", unit: "m", default: 0 },
      { key: "c", label: "Mean chord", unit: "m", default: 1.5 },
    ],
    compute: (v) => {
      const atm = isa(num(v, "h"));
      const vs = aero.stallSpeed(num(v, "m"), atm.density, num(v, "S"), num(v, "clmax"));
      return [
        { label: "Stall speed", value: Number(vs.toFixed(2)), unit: "m/s" },
        { label: "Stall speed", value: Number((vs / 0.514444).toFixed(1)), unit: "kn" },
        { label: "Reynolds number at stall", value: Number(aero.reynolds(atm.density, vs, num(v, "c"), atm.viscosity).toPrecision(3)) },
      ];
    },
  },
  {
    id: "beam",
    title: "Beam deflection",
    category: "Mechanical",
    keywords: ["beam", "deflection", "bending", "cantilever"],
    fields: [
      { key: "F", label: "Point load", unit: "N", default: 1000 },
      { key: "L", label: "Span", unit: "m", default: 2 },
      { key: "E", label: "Young's modulus", unit: "Pa", default: 200e9 },
      { key: "b", label: "Section width", unit: "m", default: 0.05 },
      { key: "h", label: "Section height", unit: "m", default: 0.1 },
    ],
    compute: (v) => {
      const I = beams.rectangleI(num(v, "b"), num(v, "h"));
      const ss = beams.simplySupportedPoint(num(v, "F"), num(v, "L"), num(v, "E"), I);
      const cl = beams.cantileverPoint(num(v, "F"), num(v, "L"), num(v, "E"), I);
      return [
        { label: "Second moment I", value: I, unit: "m⁴" },
        { label: "Simply supported deflection", value: ss.deflection, unit: "m" },
        { label: "Max bending stress (simply supported)", value: beams.bendingStress(ss.moment, num(v, "h") / 2, I), unit: "Pa" },
        { label: "Cantilever deflection", value: cl.deflection, unit: "m" },
      ];
    },
  },
  {
    id: "emi",
    title: "Loan EMI",
    category: "Everyday",
    keywords: ["loan", "emi", "interest", "mortgage"],
    fields: [
      { key: "p", label: "Principal", default: 500_000 },
      { key: "r", label: "Annual rate (%)", default: 9 },
      { key: "n", label: "Months", default: 60 },
    ],
    compute: (v) => {
      const r = loanEmi(num(v, "p"), num(v, "r"), num(v, "n"));
      return [
        { label: "Monthly payment", value: r.emi.toFixed(2) },
        { label: "Total interest", value: r.interest.toFixed(2) },
        { label: "Total paid", value: r.total.toFixed(2) },
      ];
    },
  },
  {
    id: "percent",
    title: "Percentage change",
    category: "Everyday",
    keywords: ["percent", "change", "discount"],
    fields: [
      { key: "a", label: "From", default: 80 },
      { key: "b", label: "To", default: 100 },
    ],
    compute: (v) => [{ label: "Change", value: `${percent.change(num(v, "a"), num(v, "b")).toFixed(2)} %` }],
  },
];

export function findCalculators(query: string): CalculatorDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return CALCULATORS;
  return CALCULATORS.filter((c) => c.title.toLowerCase().includes(q) || c.keywords.some((k) => k.includes(q) || q.includes(k)));
}
