import type { Reference } from "@aether/citations";
import { dateParts } from "@aether/citations";
import { FIELD_LABELS, type Criterion, type Evidence, type ExtractionItem, type GapKind, type LabProject, type ResearchQuestion, type Stance } from "./model.js";
import { canonLabel } from "./extraction.js";
import { mdCell, normalize, toCsv, tokens } from "./text.js";

// ====================================================================== matrix

export interface MatrixCell {
  text: string;
  /** "derived" = from accepted extraction items; "manual" = typed in the matrix; "empty" = nothing extracted yet. */
  kind: "derived" | "manual" | "empty";
  /** Extraction items the cell was built from (for traceability). */
  itemIds: string[];
  quotes: string[];
}

export interface Matrix {
  criteria: Criterion[];
  rows: Array<{ sourceId: string; label: string; cells: MatrixCell[] }>;
}

export function sourceLabel(ref: Reference | undefined, id: string): string {
  if (!ref) return id;
  const a = ref.author?.[0];
  const who = a ? (a.family ?? a.literal ?? "") + ((ref.author?.length ?? 0) > 2 ? " et al." : (ref.author?.length ?? 0) === 2 ? ` & ${ref.author![1]!.family ?? ref.author![1]!.literal ?? ""}` : "") : (ref.title ?? id).slice(0, 40);
  const y = dateParts(ref.issued).year;
  return `${who}${y ? ` (${y})` : ""}`;
}

export const DEFAULT_CRITERIA: Criterion[] = (["objective", "methods", "datasets", "metrics", "findings", "limitations"] as const).map((f) => ({ id: f, label: FIELD_LABELS[f], field: f }));

/** Build the comparison matrix. Only accepted extraction items fill cells; nothing is inferred for empty cells. */
export function buildMatrix(project: LabProject, refs: Record<string, Reference>, items: ExtractionItem[]): Matrix {
  const included = project.sourceIds.filter((id) => project.screening[id]?.status !== "exclude");
  const accepted = items.filter((i) => i.status === "accepted");
  return {
    criteria: project.criteria,
    rows: included.map((sourceId) => ({
      sourceId,
      label: sourceLabel(refs[sourceId], sourceId),
      cells: project.criteria.map((c): MatrixCell => {
        const manual = project.cells[sourceId]?.[c.id];
        if (manual && manual.text.trim()) return { text: manual.text, kind: "manual", itemIds: [], quotes: [] };
        const its = c.field ? accepted.filter((i) => i.sourceId === sourceId && i.field === c.field) : [];
        if (!its.length) return { text: "", kind: "empty", itemIds: [], quotes: [] };
        return { text: its.map((i) => i.text).join("; "), kind: "derived", itemIds: its.map((i) => i.id), quotes: its.map((i) => i.quote).filter((q): q is string => !!q) };
      }),
    })),
  };
}

export function matrixToCsv(m: Matrix): string {
  return toCsv([["Source", ...m.criteria.map((c) => c.label)], ...m.rows.map((r) => [r.sourceId, ...r.cells.map((c) => c.text)])]);
}

export function matrixToMarkdown(m: Matrix): string {
  const head = `| Source | ${m.criteria.map((c) => mdCell(c.label)).join(" | ")} |`;
  const sep = `|---|${m.criteria.map(() => "---").join("|")}|`;
  const rows = m.rows.map((r) => `| ${mdCell(r.label)} [@${r.sourceId}] | ${r.cells.map((c) => (c.kind === "empty" ? "—" : mdCell(c.text))).join(" | ")} |`);
  return [head, sep, ...rows].join("\n") + "\n\n— = not extracted yet.\n";
}

// ====================================================================== PRISMA-style counts

export function screeningCounts(project: LabProject) {
  const c = { identified: project.sourceIds.length, included: 0, excluded: 0, maybe: 0, unscreened: 0 };
  for (const id of project.sourceIds) {
    const s = project.screening[id]?.status;
    if (s === "include") c.included++;
    else if (s === "exclude") c.excluded++;
    else if (s === "maybe") c.maybe++;
    else c.unscreened++;
  }
  return c;
}

// ====================================================================== gaps

export interface GapHypothesis {
  key: string;
  kind: GapKind;
  /** Hedged statement, always phrased as a hypothesis about *this* project's sources. */
  statement: string;
  /** What it is based on, for traceability. */
  basis: Array<{ sourceId?: string; itemId?: string; evidenceId?: string; questionId?: string; quote?: string }>;
  caveat: string;
  strength: "weak" | "moderate";
}

const CAVEAT = (n: number) => `Based only on the ${n} source${n === 1 ? "" : "s"} in this project. A gap here may be covered by work not yet in your library; search before claiming it is a gap in the literature.`;

/**
 * Research-gap hypotheses computed from the user's own extractions and
 * evidence. Each one is deterministic, shows exactly what it is based on, and
 * is phrased as a hypothesis, never as a fact about the literature.
 */
export function gapHypotheses(project: LabProject, refs: Record<string, Reference>, items: ExtractionItem[], questions: ResearchQuestion[], evidence: Evidence[], opts: { now?: Date; datedAfterYears?: number } = {}): GapHypothesis[] {
  const included = project.sourceIds.filter((id) => project.screening[id]?.status !== "exclude");
  const n = included.length;
  const caveat = CAVEAT(n);
  const accepted = items.filter((i) => i.status === "accepted" && included.includes(i.sourceId));
  const out: GapHypothesis[] = [];

  // 1. Method × dataset combinations never studied together.
  const labelsBy = (field: "methods" | "datasets") => {
    const m = new Map<string, { display: string; sources: Set<string> }>();
    for (const i of accepted.filter((x) => x.field === field)) {
      for (const l of i.labels) {
        const k = canonLabel(l);
        if (!k) continue;
        const e = m.get(k) ?? { display: l, sources: new Set<string>() };
        e.sources.add(i.sourceId);
        m.set(k, e);
      }
    }
    return m;
  };
  const methods = labelsBy("methods");
  const datasets = labelsBy("datasets");
  const combos: GapHypothesis[] = [];
  for (const [mk, mv] of methods) {
    if (mv.sources.size < 2) continue;
    for (const [dk, dv] of datasets) {
      if (dv.sources.size < 2) continue;
      const both = [...mv.sources].filter((s) => dv.sources.has(s));
      if (both.length) continue;
      combos.push({
        key: `combo:${mk}|${dk}`,
        kind: "uncovered-combination",
        statement: `No source in this project applies “${mv.display}” to “${dv.display}”, although ${mv.sources.size} sources use the method and ${dv.sources.size} use the dataset.`,
        basis: [...[...mv.sources].map((s) => ({ sourceId: s })), ...[...dv.sources].map((s) => ({ sourceId: s }))],
        caveat,
        strength: mv.sources.size + dv.sources.size >= 6 ? "moderate" : "weak",
      });
    }
  }
  out.push(...combos.slice(0, 20));

  // 2–4. Question coverage.
  for (const q of questions) {
    const ev = evidence.filter((e) => e.questionId === q.id && included.includes(e.sourceId));
    const sources = new Set(ev.map((e) => e.sourceId));
    if (!ev.length) {
      out.push({ key: `unanswered:${q.id}`, kind: "unanswered-question", statement: `No evidence has been linked to the question “${q.text}”.`, basis: [{ questionId: q.id }], caveat: "You may not have reviewed the relevant sources yet. " + caveat, strength: "weak" });
      continue;
    }
    if (sources.size === 1) out.push({ key: `thin:${q.id}`, kind: "thin-evidence", statement: `Only one source (${sourceLabel(refs[[...sources][0]!], [...sources][0]!)}) addresses “${q.text}”.`, basis: ev.map((e) => ({ evidenceId: e.id, sourceId: e.sourceId, questionId: q.id })), caveat, strength: "weak" });
    const sup = ev.filter((e) => e.stance === "supports");
    const con = ev.filter((e) => e.stance === "contradicts");
    if (sup.length && con.length)
      out.push({
        key: `contested:${q.id}`,
        kind: "contested",
        statement: `Sources disagree on “${q.text}”: ${sup.length} support and ${con.length} contradict. The disagreement itself may be worth investigating (different conditions, methods or datasets).`,
        basis: [...sup, ...con].map((e) => ({ evidenceId: e.id, sourceId: e.sourceId, questionId: q.id, quote: e.quote })),
        caveat,
        strength: sup.length + con.length >= 4 ? "moderate" : "weak",
      });
    const years = [...sources].map((s) => Number(dateParts(refs[s]?.issued).year)).filter((y) => y > 0);
    const thisYear = (opts.now ?? new Date()).getUTCFullYear();
    const limit = opts.datedAfterYears ?? 10;
    if (years.length && Math.max(...years) < thisYear - limit)
      out.push({ key: `dated:${q.id}`, kind: "dated-evidence", statement: `The newest evidence for “${q.text}” is from ${Math.max(...years)}. Newer work may exist or the question may need revisiting.`, basis: ev.map((e) => ({ evidenceId: e.id, sourceId: e.sourceId })), caveat, strength: "weak" });
  }

  // 5. Limitations shared by several sources (by labels, else by repeated key terms).
  const limItems = accepted.filter((i) => i.field === "limitations");
  const termSources = new Map<string, { display: string; items: ExtractionItem[] }>();
  for (const i of limItems) {
    const terms = new Set(i.labels.length ? i.labels.map(canonLabel) : bigrams(i.text));
    for (const t of terms) {
      const e = termSources.get(t) ?? { display: i.labels.find((l) => canonLabel(l) === t) ?? t, items: [] };
      if (!e.items.some((x) => x.sourceId === i.sourceId)) e.items.push(i);
      termSources.set(t, e);
    }
  }
  for (const [t, v] of [...termSources].filter(([, v]) => v.items.length >= 2).sort((a, b) => b[1].items.length - a[1].items.length).slice(0, 10)) {
    out.push({
      key: `limitation:${t}`,
      kind: "shared-limitation",
      statement: `${v.items.length} sources report a limitation involving “${v.display}”. Addressing it could be a contribution.`,
      basis: v.items.map((i) => ({ sourceId: i.sourceId, itemId: i.id, quote: i.quote })),
      caveat,
      strength: v.items.length >= 3 ? "moderate" : "weak",
    });
  }

  // 6. Future work the authors themselves state (quoted, attributed).
  for (const i of accepted.filter((x) => x.field === "futureWork").slice(0, 30)) {
    out.push({ key: `future:${i.id}`, kind: "stated-future-work", statement: `${sourceLabel(refs[i.sourceId], i.sourceId)} names open work: “${i.text}”.`, basis: [{ sourceId: i.sourceId, itemId: i.id, quote: i.quote }], caveat: "Stated by the authors at publication time; later work may have addressed it.", strength: "weak" });
  }
  return out;
}

function bigrams(text: string): string[] {
  const t = tokens(text, { stop: true });
  const out: string[] = [];
  for (let i = 0; i + 1 < t.length; i++) out.push(`${t[i]} ${t[i + 1]}`);
  return out;
}

// ====================================================================== review outline

export interface OutlineBullet {
  text: string;
  /** Citation keys backing this bullet. Every bullet has at least one. */
  cites: string[];
  stance?: Stance;
  evidenceIds: string[];
  locator?: string;
}

export interface OutlineSection {
  heading: string;
  questionId?: string;
  bullets: OutlineBullet[];
  /** Things the user still needs to do before this section is defensible. */
  todo: string[];
}

export interface ReviewOutline {
  title: string;
  sections: OutlineSection[];
  citedKeys: string[];
  warnings: string[];
}

const STANCE_LABEL: Record<Stance, string> = { supports: "Evidence for", contradicts: "Evidence against", mixed: "Mixed or conditional evidence", context: "Context" };

/**
 * Evidence-backed literature-review outline. Built only from evidence the
 * user linked to questions and from accepted extractions; a bullet without a
 * source is never generated. Questions with no evidence become explicit TODOs.
 */
export function buildOutline(project: LabProject, refs: Record<string, Reference>, questions: ResearchQuestion[], evidence: Evidence[], items: ExtractionItem[], keptGaps: GapHypothesis[] = []): ReviewOutline {
  const included = new Set(project.sourceIds.filter((id) => project.screening[id]?.status !== "exclude"));
  const sections: OutlineSection[] = [];
  const cited = new Set<string>();
  const warnings: string[] = [];
  const loc = (e: Evidence) => (e.locator?.page ? `p. ${e.locator.page}` : e.locator?.label);

  sections.push({
    heading: "Introduction",
    bullets: [],
    todo: [`State the scope: ${project.description?.trim() || project.title}.`, `Report how sources were found and screened (${screeningSummary(project)}).`],
  });

  const accepted = items.filter((i) => i.status === "accepted" && included.has(i.sourceId));
  const methodItems = accepted.filter((i) => i.field === "methods");
  if (methodItems.length) {
    const groups = groupByLabel(methodItems);
    sections.push({
      heading: "Approaches in the literature",
      bullets: groups.map((g) => {
        g.sources.forEach((s) => cited.add(s));
        return { text: g.label ? `${g.label}: ${g.items.map((i) => i.text).join("; ")}` : g.items.map((i) => i.text).join("; "), cites: g.sources, evidenceIds: [] };
      }),
      todo: [],
    });
  }

  const top = questions.filter((q) => !q.parentId).sort((a, b) => a.order - b.order);
  for (const q of top) {
    const qIds = new Set([q.id, ...questions.filter((x) => x.parentId === q.id).map((x) => x.id)]);
    const ev = evidence.filter((e) => qIds.has(e.questionId) && included.has(e.sourceId));
    const sec: OutlineSection = { heading: q.text, questionId: q.id, bullets: [], todo: [] };
    if (!ev.length) sec.todo.push("No evidence linked yet. Add evidence from your sources before writing this section.");
    for (const stance of ["supports", "contradicts", "mixed", "context"] as Stance[]) {
      for (const e of ev.filter((x) => x.stance === stance)) {
        if (!refs[e.sourceId]) warnings.push(`Evidence cites ${e.sourceId}, which is not in the library snapshot.`);
        cited.add(e.sourceId);
        sec.bullets.push({ text: `${STANCE_LABEL[stance]}: ${e.claim}`, cites: [e.sourceId], stance, evidenceIds: [e.id], locator: loc(e) });
      }
    }
    if (ev.some((e) => e.stance === "supports") && ev.some((e) => e.stance === "contradicts")) sec.todo.push("Explain why sources disagree (conditions, methods, datasets).");
    if (new Set(ev.map((e) => e.sourceId)).size === 1) sec.todo.push("Only one source: look for corroborating or contrasting work.");
    sections.push(sec);
  }

  const lim = accepted.filter((i) => i.field === "limitations");
  if (lim.length) {
    sections.push({ heading: "Limitations reported in the literature", bullets: lim.map((i) => (cited.add(i.sourceId), { text: i.text, cites: [i.sourceId], evidenceIds: [] })), todo: [] });
  }
  if (keptGaps.length) {
    sections.push({
      heading: "Open questions and possible gaps",
      bullets: keptGaps
        .map((g) => ({ text: `${g.statement} (hypothesis)`, cites: [...new Set(g.basis.map((b) => b.sourceId).filter((s): s is string => !!s))], evidenceIds: g.basis.map((b) => b.evidenceId).filter((x): x is string => !!x) }))
        .filter((b) => b.cites.length > 0)
        .map((b) => (b.cites.forEach((c) => cited.add(c)), b)),
      todo: ["Search beyond this project before presenting these as gaps in the literature."],
    });
  }
  sections.push({ heading: "Conclusion", bullets: [], todo: ["Summarise the answer to each question and the strength of the evidence."] });
  return { title: `Literature review: ${project.title}`, sections, citedKeys: [...cited], warnings };
}

function screeningSummary(project: LabProject): string {
  const c = screeningCounts(project);
  return `${c.identified} identified, ${c.included} included, ${c.excluded} excluded${c.maybe ? `, ${c.maybe} undecided` : ""}${c.unscreened ? `, ${c.unscreened} not yet screened` : ""}`;
}

function groupByLabel(items: ExtractionItem[]): Array<{ label?: string; items: ExtractionItem[]; sources: string[] }> {
  const groups = new Map<string, { label?: string; items: ExtractionItem[] }>();
  for (const i of items) {
    const k = i.labels[0] ? canonLabel(i.labels[0]) : `_${i.id}`;
    const g = groups.get(k) ?? { label: i.labels[0], items: [] };
    g.items.push(i);
    groups.set(k, g);
  }
  return [...groups.values()].map((g) => ({ ...g, sources: [...new Set(g.items.map((i) => i.sourceId))] }));
}

/** Markdown for the Writer: [@key] citations, an explicit note that it is an outline to rewrite, and TODOs as quotes. */
export function outlineToMarkdown(o: ReviewOutline): string {
  const lines: string[] = [`# ${o.title}`, "", "> Outline generated by Research & Writing module from your linked evidence. Each point cites the source it came from. Rewrite in your own words and check every claim against the source before submitting.", ""];
  for (const s of o.sections) {
    lines.push(`## ${s.heading}`, "");
    for (const b of s.bullets) lines.push(`- ${b.text.replace(/\s+/g, " ")} [${b.cites.map((c, i) => `@${c}${i === 0 && b.locator ? `, ${b.locator}` : ""}`).join("; ")}]`);
    if (s.bullets.length) lines.push("");
    for (const t of s.todo) lines.push(`> TODO: ${t}`);
    if (s.todo.length) lines.push("");
  }
  return lines.join("\n");
}

/** Quick lexical check that a phrase or term appears in a project's sources (titles, abstracts, accepted items). */
export function sourcesMentioning(term: string, refs: Record<string, Reference>, items: ExtractionItem[]): string[] {
  const t = normalize(term);
  if (!t) return [];
  const hits = new Set<string>();
  for (const [id, r] of Object.entries(refs)) if (normalize(`${r.title ?? ""} ${r.abstract ?? ""}`).includes(t)) hits.add(id);
  for (const i of items) if (i.status === "accepted" && normalize(i.text).includes(t)) hits.add(i.sourceId);
  return [...hits];
}
