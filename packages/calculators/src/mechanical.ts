/** Mechanical and aerospace helpers, SI units throughout. */

/** International Standard Atmosphere (ICAO Doc 7488), valid 0–32 km geopotential altitude. */
export function isa(altitude: number, deltaT = 0) {
  const g0 = 9.806_65;
  const R = 287.052_87;
  const layers = [
    { h: 0, T: 288.15, L: -0.0065, p: 101_325 },
    { h: 11_000, T: 216.65, L: 0, p: 22_632.06 },
    { h: 20_000, T: 216.65, L: 0.001, p: 5_474.889 },
    { h: 32_000, T: 228.65, L: 0.0028, p: 868.0187 },
  ];
  if (altitude < -610 || altitude > 47_000) throw new RangeError("ISA model here covers −610 m to 47 km.");
  const layer = [...layers].reverse().find((l) => altitude >= l.h) ?? layers[0]!;
  const dh = altitude - layer.h;
  const Tstd = layer.T + layer.L * dh;
  const p = layer.L === 0 ? layer.p * Math.exp((-g0 * dh) / (R * layer.T)) : layer.p * (Tstd / layer.T) ** (-g0 / (R * layer.L));
  const T = Tstd + deltaT;
  const rho = p / (R * T);
  const a = Math.sqrt(1.4 * R * T);
  // Sutherland's law for dynamic viscosity.
  const mu = (1.458e-6 * T ** 1.5) / (T + 110.4);
  return { temperature: T, pressure: p, density: rho, speedOfSound: a, viscosity: mu, densityRatio: rho / 1.225 };
}

export const aero = {
  lift: (CL: number, rho: number, V: number, S: number) => 0.5 * rho * V * V * S * CL,
  drag: (CD: number, rho: number, V: number, S: number) => 0.5 * rho * V * V * S * CD,
  /** Speed needed for lift = weight. */
  stallSpeed: (mass: number, rho: number, S: number, CLmax: number) => Math.sqrt((2 * mass * 9.806_65) / (rho * S * CLmax)),
  reynolds: (rho: number, V: number, L: number, mu: number) => (rho * V * L) / mu,
  mach: (V: number, a: number) => V / a,
  dynamicPressure: (rho: number, V: number) => 0.5 * rho * V * V,
  aspectRatio: (span: number, area: number) => (span * span) / area,
  /** Induced drag coefficient with Oswald efficiency e. */
  inducedDrag: (CL: number, AR: number, e = 0.8) => (CL * CL) / (Math.PI * AR * e),
};

export const beams = {
  /** Simply supported beam, central point load: max deflection and moment. */
  simplySupportedPoint: (F: number, L: number, E: number, I: number) => ({ deflection: (F * L ** 3) / (48 * E * I), moment: (F * L) / 4 }),
  /** Simply supported beam, uniform load w (N/m). */
  simplySupportedUniform: (w: number, L: number, E: number, I: number) => ({ deflection: (5 * w * L ** 4) / (384 * E * I), moment: (w * L * L) / 8 }),
  /** Cantilever with end point load. */
  cantileverPoint: (F: number, L: number, E: number, I: number) => ({ deflection: (F * L ** 3) / (3 * E * I), moment: F * L }),
  cantileverUniform: (w: number, L: number, E: number, I: number) => ({ deflection: (w * L ** 4) / (8 * E * I), moment: (w * L * L) / 2 }),
  rectangleI: (b: number, h: number) => (b * h ** 3) / 12,
  circleI: (d: number) => (Math.PI * d ** 4) / 64,
  tubeI: (D: number, d: number) => (Math.PI * (D ** 4 - d ** 4)) / 64,
  bendingStress: (M: number, c: number, I: number) => (M * c) / I,
};

export const stressStrain = {
  stress: (F: number, A: number) => F / A,
  strain: (dL: number, L: number) => dL / L,
  youngsModulus: (stress: number, strain: number) => stress / strain,
  safetyFactor: (strength: number, stress: number) => strength / stress,
};

/** Common material properties (typical room-temperature values; check datasheets for design). */
export const MATERIALS = {
  "Steel (structural A36)": { E: 200e9, yield: 250e6, density: 7850 },
  "Aluminium 6061-T6": { E: 68.9e9, yield: 276e6, density: 2700 },
  "Aluminium 7075-T6": { E: 71.7e9, yield: 503e6, density: 2810 },
  "Titanium Ti-6Al-4V": { E: 113.8e9, yield: 880e6, density: 4430 },
  "Carbon fibre (CFRP, quasi-iso)": { E: 70e9, yield: 600e6, density: 1600 },
  "Copper (annealed)": { E: 117e9, yield: 70e6, density: 8960 },
  "PLA (3D print)": { E: 3.5e9, yield: 50e6, density: 1240 },
} as const;
