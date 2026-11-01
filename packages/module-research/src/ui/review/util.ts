import type { LabProject } from "../../model.js";
export { sourceLabel } from "../../analysis.js";

export function screeningCountsOf(p: LabProject) {
  const c = { identified: p.sourceIds.length, included: 0, excluded: 0, maybe: 0, unscreened: 0 };
  for (const id of p.sourceIds) {
    const s = p.screening[id]?.status;
    if (s === "include") c.included++;
    else if (s === "exclude") c.excluded++;
    else if (s === "maybe") c.maybe++;
    else c.unscreened++;
  }
  return c;
}

export const includedIds = (p: LabProject) => p.sourceIds.filter((id) => p.screening[id]?.status !== "exclude");
