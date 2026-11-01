import { describe, expect, it } from "vitest";
import type { Reference } from "@aether/citations";
import { buildMatrix, buildOutline, gapHypotheses, matrixToCsv, matrixToMarkdown, DEFAULT_CRITERIA } from "../src/analysis.js";
import type { Evidence, ExtractionItem, LabProject, ResearchQuestion } from "../src/model.js";

const t = "2026-01-01T00:00:00Z";
const ref = (id: string, year: number): Reference => ({ id, type: "article-journal", title: `Paper ${id}`, author: [{ family: id.toUpperCase() }], issued: { "date-parts": [[year]] } });
const ids = ["a", "b", "c", "d"];
const project: LabProject = { id: "p", createdAt: t, updatedAt: t, title: "T", sourceIds: [...ids, "x"], sources: Object.fromEntries([...ids, "x"].map((i) => [i, ref(i, 2024)])), criteria: DEFAULT_CRITERIA, cells: { a: { findings: { text: "=cmd|' /C calc'!A0", origin: "manual", at: t } } }, screening: { x: { status: "exclude", at: t } } };
let n = 0;
const item = (sourceId: string, field: ExtractionItem["field"], labels: string[], status: ExtractionItem["status"] = "accepted"): ExtractionItem => ({ id: `i${n++}`, createdAt: t, updatedAt: t, projectId: "p", sourceId, field, text: `${field} of ${sourceId}`, labels, origin: "manual", status, quote: `quote ${sourceId}` });
const items = [
  item("a", "methods", ["CNN"]), item("b", "methods", ["CNN"]), item("c", "methods", ["SVM"]),
  item("c", "datasets", ["MIT-BIH"]), item("d", "datasets", ["MIT-BIH"]), item("a", "datasets", ["PTB"]),
  item("a", "limitations", ["small sample"]), item("b", "limitations", ["small sample"]),
  item("x", "methods", ["CNN"]), item("d", "findings", [], "suggested"),
];
const q: ResearchQuestion[] = [{ id: "q1", createdAt: t, updatedAt: t, projectId: "p", text: "Does it work?", status: "open", order: 0 }, { id: "q2", createdAt: t, updatedAt: t, projectId: "p", text: "Is it cheap?", status: "open", order: 1 }];
const ev = (id: string, sourceId: string, stance: Evidence["stance"]): Evidence => ({ id, createdAt: t, updatedAt: t, projectId: "p", questionId: "q1", sourceId, stance, claim: `claim ${id}`, origin: "manual" });
const evidence = [ev("e1", "a", "supports"), ev("e2", "b", "contradicts"), ev("e3", "x", "supports")];

describe("analysis", () => {
  it("matrix excludes screened-out sources, ignores suggestions, never fills empty cells", () => {
    const m = buildMatrix(project, project.sources, items);
    expect(m.rows.map((r) => r.sourceId)).toEqual(ids);
    const d = m.rows.find((r) => r.sourceId === "d")!;
    expect(d.cells.find((_, i) => m.criteria[i]!.field === "findings")!.kind).toBe("empty");
    expect(matrixToCsv(m)).toContain(",'=cmd");
    expect(matrixToMarkdown(m)).toContain("[@a]");
  });
  it("gap hypotheses are traceable, hedged and ignore excluded sources", () => {
    const g = gapHypotheses(project, project.sources, items, q, evidence, { now: new Date("2026-06-01") });
    const kinds = g.map((x) => x.kind);
    expect(g.find((x) => x.kind === "uncovered-combination")!.statement).toMatch(/No source in this project applies “CNN” to “MIT-BIH”/);
    expect(kinds).toContain("contested");
    expect(kinds).toContain("unanswered-question");
    expect(kinds).toContain("shared-limitation");
    for (const h of g) expect(h.caveat).toBeTruthy();
    expect(JSON.stringify(g)).not.toContain('"sourceId":"x"');
  });
  it("outline bullets all cite, and unanswered questions become TODOs", () => {
    const o = buildOutline(project, project.sources, q, evidence, items);
    const s2 = o.sections.find((s) => s.questionId === "q2")!;
    expect(s2.bullets).toHaveLength(0);
    expect(s2.todo[0]).toMatch(/No evidence/);
    const s1 = o.sections.find((s) => s.questionId === "q1")!;
    expect(s1.todo.join(" ")).toMatch(/disagree/);
    expect(o.citedKeys).not.toContain("x");
    for (const s of o.sections) for (const b of s.bullets) expect(b.cites.length).toBeGreaterThan(0);
  });
});
