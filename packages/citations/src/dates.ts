import type { CslDate } from "./types.js";

export interface DateParts {
  year?: number;
  month?: number;
  day?: number;
}

export function dateParts(d: CslDate | undefined): DateParts {
  if (!d) return {};
  const p = d["date-parts"]?.[0];
  if (p && p.length) {
    const [y, m, day] = p.map((v) => (typeof v === "string" ? parseInt(v, 10) : v));
    return {
      year: Number.isFinite(y) ? y : undefined,
      month: Number.isFinite(m) ? m : undefined,
      day: Number.isFinite(day) ? day : undefined,
    };
  }
  const raw = d.raw ?? d.literal;
  if (raw) return parseDateString(raw);
  return {};
}

/** Accepts "2021", "2021-03", "2021-03-04", "March 2021", "4 Mar 2021". */
export function parseDateString(raw: string): DateParts {
  const s = raw.trim();
  const iso = s.match(/^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?/);
  if (iso) {
    return {
      year: +iso[1]!,
      month: iso[2] ? +iso[2] : undefined,
      day: iso[3] ? +iso[3] : undefined,
    };
  }
  const year = s.match(/\b(\d{4})\b/);
  const monthIdx = MONTHS_FULL.findIndex((m) => new RegExp(`\\b${m.slice(0, 3)}`, "i").test(s));
  const day = s.match(/\b(\d{1,2})\b(?!\d)/);
  return {
    year: year ? +year[1]! : undefined,
    month: monthIdx >= 0 ? monthIdx + 1 : undefined,
    day: monthIdx >= 0 && day ? +day[1]! : undefined,
  };
}

export function makeDate(year?: number, month?: number, day?: number): CslDate | undefined {
  if (!year) return undefined;
  const parts: number[] = [year];
  if (month) {
    parts.push(month);
    if (day) parts.push(day);
  }
  return { "date-parts": [parts] };
}

export const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
/** IEEE abbreviations (IEEE Editorial Style Manual). */
export const MONTHS_IEEE = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "Jun.", "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec."];
/** MLA abbreviations. */
export const MONTHS_MLA = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

/** Normalise page ranges to an en dash: "10-20" / "10--20" → "10–20". */
export function pageRange(page: string | undefined): string | undefined {
  return page?.replace(/\s*(--?|–|—)\s*/g, "–");
}

export function isPageRange(page: string | undefined): boolean {
  return !!page && /[-–,]/.test(page);
}
