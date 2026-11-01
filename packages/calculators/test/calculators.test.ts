import { describe, it, expect } from "vitest";
import {
  evaluate, evaluateLines, ExprError, convert, convertPhrase, UnitError, formatSI, formatEngineering,
  ohmsLaw, voltageDivider, rcFilter, lcResonance, decodeResistorBands, encodeResistorBands, nearestPreferred, seriesValues,
  awg, pcbTraceWidth, timer555Astable, isa, aero, beams, convertBase, twosComplement, loanEmi, stats, linearFit, CALCULATORS,
} from "@aether/calculators";

const close = (a: number, b: number, rel = 1e-6) => expect(Math.abs(a - b) / Math.max(Math.abs(b), 1e-300)).toBeLessThan(rel);

describe("expression evaluator", () => {
  it("handles precedence, power associativity and unary minus", () => {
    expect(evaluate("1 + 2 * 3")).toBe(7);
    expect(evaluate("2 ^ 3 ^ 2")).toBe(512);
    expect(evaluate("-2 ^ 2")).toBe(-4);
    expect(evaluate("(1 + 2) * 3 % 4")).toBe(1);
    expect(evaluate("2 ** 10")).toBe(1024);
  });
  it("understands SI suffixes and parallel operator", () => {
    expect(evaluate("4.7k")).toBe(4700);
    close(evaluate("100n"), 1e-7);
    expect(evaluate("1meg")).toBe(1e6);
    expect(evaluate("10k || 10k")).toBe(5000);
    expect(evaluate("par(1k, 1k, 1k)")).toBeCloseTo(333.333, 2);
    expect(evaluate("1.5e3")).toBe(1500);
  });
  it("supports constants, functions and variables", () => {
    const scope = new Map<string, number>();
    evaluate("R = 1k", scope);
    evaluate("C = 1u", scope);
    close(evaluate("1/(2*pi*R*C)", scope), 159.154943);
    expect(evaluate("ans * 2", scope)).toBeCloseTo(318.31, 2);
    expect(evaluate("sind(30)")).toBeCloseTo(0.5, 12);
    expect(evaluate("log(8, 2)")).toBeCloseTo(3, 12);
    expect(evaluate("db(10)")).toBe(20);
    expect(evaluate("max(1, 5, 3)")).toBe(5);
    expect(evaluate("nCr(5, 2)")).toBe(10);
  });
  it("rejects anything that is not arithmetic", () => {
    expect(() => evaluate("constructor")).toThrow(ExprError);
    expect(() => evaluate("process.exit()")).toThrow(ExprError);
    expect(() => evaluate("alert(1)")).toThrow(/Unknown function/);
    expect(() => evaluate("1 +")).toThrow(/end of expression/);
    expect(() => evaluate("sin(1, 2)")).toThrow(/argument/);
    expect(() => evaluate("(1")).toThrow(/Expected "\)"/);
  });
  it("evaluates scratchpad lines with comments and errors", () => {
    const r = evaluateLines(["a = 2 # two", "", "a * 3", "bad +"]);
    expect(r.map((x) => x.value)).toEqual([2, undefined, 6, undefined]);
    expect(r[3]!.error).toBeTruthy();
  });
});

describe("units", () => {
  it("converts simple and prefixed units", () => {
    close(convert(1, "km", "m"), 1000);
    close(convert(60, "mph", "km/h"), 96.56064);
    close(convert(1, "kWh", "J"), 3.6e6);
    close(convert(14.7, "psi", "kPa"), 101.3525, 1e-5);
    close(convert(1, "GiB", "MB"), 1073.741824);
    close(convert(3.3, "kΩ", "ohm"), 3300);
    close(convert(1, "nmi", "m"), 1852);
    close(convert(180, "deg", "rad"), Math.PI);
  });
  it("handles compound units with powers", () => {
    close(convert(1, "kg*m/s^2", "N"), 1);
    close(convert(1, "N·m", "J"), 1);
    close(convert(1, "m²", "cm^2"), 1e4);
    close(convert(2000, "mAh", "C"), 7200);
  });
  it("converts temperature with offsets", () => {
    close(convert(100, "°C", "°F"), 212);
    close(convert(-40, "degF", "degC"), -40);
    close(convert(0, "degC", "K"), 273.15);
  });
  it("rejects incompatible or unknown units", () => {
    expect(() => convert(1, "m", "s")).toThrow(UnitError);
    expect(() => convert(1, "furlongz", "m")).toThrow(/Unknown unit/);
  });
  it("parses phrases", () => {
    const r = convertPhrase("250 kn to km/h")!;
    close(r.result, 463);
    expect(convertPhrase("hello world")).toBeUndefined();
  });
});

describe("formatting", () => {
  it("formats with SI prefixes", () => {
    expect(formatSI(4700, "Ω")).toBe("4.7 kΩ");
    expect(formatSI(1.5e-7, "F")).toBe("150 nF");
    expect(formatSI(0.99999, "V", 3)).toBe("1 V");
    expect(formatSI(999.96, "Hz")).toBe("1 kHz");
    expect(formatSI(0)).toBe("0");
    expect(formatEngineering(0.00047)).toBe("470e-6");
  });
});

describe("electronics", () => {
  it("solves Ohm's law from any pair", () => {
    expect(ohmsLaw({ V: 12, R: 4 })).toEqual({ V: 12, I: 3, R: 4, P: 36 });
    expect(ohmsLaw({ P: 36, R: 4 })).toEqual({ V: 12, I: 3, R: 4, P: 36 });
    expect(() => ohmsLaw({ V: 1 })).toThrow(/exactly two/);
  });
  it("divider, RC and LC", () => {
    expect(voltageDivider(10, 10e3, 10e3).vout).toBe(5);
    close(voltageDivider(10, 10e3, 10e3, 10e3).vout, 10 / 3);
    close(rcFilter(1e3, 1e-6).fc, 159.1549431);
    close(lcResonance(10e-6, 100e-12).f0, 5.0329212e6);
  });
  it("decodes and encodes resistor colour bands", () => {
    expect(decodeResistorBands(["yellow", "violet", "red", "gold"])).toEqual({ ohms: 4700, tolerance: 5, tempco: undefined });
    expect(decodeResistorBands(["brown", "black", "black", "red", "brown", "red"])).toEqual({ ohms: 10000, tolerance: 1, tempco: 50 });
    expect(decodeResistorBands(["Brown", "Black", "gold", "gold"]).ohms).toBe(1);
    expect(encodeResistorBands(4700)).toEqual(["yellow", "violet", "red", "gold"]);
    expect(encodeResistorBands(2.2)).toEqual(["red", "red", "gold", "gold"]);
    expect(encodeResistorBands(12_100, 1, 5)).toEqual(["brown", "red", "brown", "red", "brown"]);
    expect(() => decodeResistorBands(["pink", "black", "red"])).toThrow();
  });
  it("finds preferred values", () => {
    expect(seriesValues("E12")).toEqual([1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2]);
    expect(seriesValues("E96")).toHaveLength(96);
    expect(seriesValues("E192")[185]).toBe(9.2);
    expect(nearestPreferred(4500)).toBe(4700);
    expect(nearestPreferred(150, "E24", "up")).toBe(150);
    expect(nearestPreferred(151, "E24", "up")).toBe(160);
    expect(nearestPreferred(9.6e3, "E12")).toBe(10e3);
    expect(nearestPreferred(1234, "E96")).toBe(1240);
  });
  it("wire, PCB and 555", () => {
    close(awg(24).diameter, 0.5106e-3, 1e-3);
    close(awg(24).ohmsPerMeter, 0.0842, 1e-2);
    expect(pcbTraceWidth(1, 10, 1).widthMil).toBeCloseTo(11.8, 0);
    const t = timer555Astable(1e3, 10e3, 10e-6);
    close(t.frequency, 6.8711, 1e-3);
  });
});

describe("mechanical and aerospace", () => {
  it("ISA matches published values", () => {
    const sl = isa(0);
    close(sl.pressure, 101_325);
    close(sl.density, 1.225, 1e-3);
    close(sl.speedOfSound, 340.29, 1e-3);
    const fl350 = isa(10_668);
    close(fl350.temperature, 218.81, 1e-3);
    close(fl350.pressure, 23_842, 2e-3);
    close(isa(15_000).temperature, 216.65);
    expect(() => isa(60_000)).toThrow(RangeError);
  });
  it("aero and beams", () => {
    expect(aero.stallSpeed(1100, 1.225, 16.2, 1.6)).toBeCloseTo(26.07, 1);
    const I = beams.rectangleI(0.05, 0.1);
    close(I, 4.1667e-6, 1e-4);
    close(beams.simplySupportedPoint(1000, 2, 200e9, I).deflection, 2e-4, 1e-3);
  });
});

describe("everyday", () => {
  it("base conversion and two's complement", () => {
    expect(convertBase("0xFF")).toMatchObject({ dec: "255", bin: "11111111", oct: "377" });
    expect(convertBase("1010_1010", 2).hex).toBe("aa");
    expect(convertBase("18446744073709551615").hex).toBe("ffffffffffffffff");
    expect(() => convertBase("12z")).toThrow();
    expect(twosComplement(-1, 8)).toBe("11111111");
    expect(twosComplement(-128, 8)).toBe("10000000");
    expect(() => twosComplement(128, 8)).toThrow();
  });
  it("EMI, stats and linear fit", () => {
    expect(loanEmi(100_000, 12, 12).emi).toBeCloseTo(8884.88, 2);
    expect(loanEmi(1200, 0, 12).emi).toBe(100);
    expect(stats([2, 4, 4, 4, 5, 5, 7, 9])).toMatchObject({ mean: 5, median: 4.5, min: 2, max: 9 });
    const f = linearFit([[0, 1], [1, 3], [2, 5]]);
    expect(f).toEqual({ slope: 2, intercept: 1, r2: 1 });
  });
  it("every registered calculator computes with its defaults", () => {
    for (const c of CALCULATORS) {
      const v = Object.fromEntries(c.fields.map((f) => [f.key, f.default]));
      if (c.id === "ohm") Object.assign(v, { V: 5, R: 100 });
      const out = c.compute(v);
      expect(out.length, c.id).toBeGreaterThan(0);
      for (const o of out) if (typeof o.value === "number") expect(Number.isFinite(o.value), `${c.id}: ${o.label}`).toBe(true);
    }
  });
});
