import type { Reference } from "@aether/citations";
import { dateParts, findDuplicates, validateReference } from "@aether/citations";
import type { VerificationRecord } from "./model.js";

/**
 * Citation-quality report for a set of references. Works offline: it uses the
 * references themselves plus any verification records already stored. Each
 * finding says what was checked and why it matters; there is no opaque score.
 */

export type QualityCode =
  | "incomplete"
  | "invalid-field"
  | "no-identifier"
  | "unverified"
  | "verify-failed"
  | "doi-not-found"
  | "metadata-mismatch"
  | "retracted"
  | "notice"
  | "preprint"
  | "preprint-published"
  | "web-only"
  | "dated"
  | "duplicate"
  | "cited-not-in-library";

export interface QualityFinding {
  refId: string;
  code: QualityCode;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface QualityReport {
  checkedAt: string;
  total: number;
  verified: number;
  findings: QualityFinding[];
  /** Counts per severity, for a summary line. */
  counts: { error: number; warning: number; info: number };
  /** What this report does not check. */
  limits: string[];
}

export const QUALITY_LIMITS = [
  "Checks metadata and registry records only. It cannot tell whether a source actually supports the sentence that cites it; read the source.",
  "“Verified” uses the last online check stored on this device. Run verification again before submitting.",
  "Retraction data comes from Crossref (including Retraction Watch) and OpenAlex and may lag behind journals.",
];

export function qualityReport(refs: Reference[], verifications: Map<string, VerificationRecord>, opts: { now?: Date; datedAfterYears?: number; citedKeys?: string[] } = {}): QualityReport {
  const now = opts.now ?? new Date();
  const findings: QualityFinding[] = [];
  const add = (refId: string, code: QualityCode, severity: QualityFinding["severity"], message: string) => findings.push({ refId, code, severity, message });
  const thisYear = now.getUTCFullYear();
  let verified = 0;

  for (const r of refs) {
    for (const issue of validateReference(r)) add(r.id, issue.severity === "error" ? "invalid-field" : "incomplete", issue.severity, issue.message);
    const isArxiv = /arxiv/i.test(r.archive ?? "") || /arxiv\.org/i.test(r.URL ?? "");
    if (!r.DOI && !isArxiv && !r.ISBN && !r.URL && !r.PMID) add(r.id, "no-identifier", "warning", "No DOI, arXiv id, ISBN, PMID or URL, so readers (and AETHER) cannot check it.");
    if (isArxiv && !r.DOI) add(r.id, "preprint", "info", "Preprint (not peer reviewed). Check whether a published version exists.");
    if ((r.type === "webpage" || r.type === "post-weblog") && !r.DOI) add(r.id, "web-only", "info", "Web source: content can change; keep an access date or an archived copy.");
    const y = Number(dateParts(r.issued).year);
    if (y && opts.datedAfterYears && thisYear - y > opts.datedAfterYears) add(r.id, "dated", "info", `Published ${thisYear - y} years ago; check for newer work if it supports a current-state claim.`);

    const v = verifications.get(r.id);
    if (!v) {
      if (r.DOI || isArxiv || r.title) add(r.id, "unverified", "info", "Not yet checked against a registry.");
      continue;
    }
    if (v.status === "verified") verified++;
    if (v.status === "not-found") add(r.id, "doi-not-found", "error", v.message);
    if (v.status === "mismatch") add(r.id, "metadata-mismatch", v.diffs.some((d) => d.severity === "error") ? "error" : "warning", `${v.message} Fields: ${v.diffs.map((d) => d.field).join(", ")}.`);
    if (v.status === "error") add(r.id, "verify-failed", "info", `Last check failed: ${v.message}`);
    if (v.status === "candidate" && v.candidate?.DOI) add(r.id, "no-identifier", "info", `A likely DOI was found (${v.candidate.DOI}); confirm it in the verifier.`);
    if (isArxiv && v.candidate?.DOI && !r.DOI) add(r.id, "preprint-published", "warning", `arXiv lists a published version (DOI ${v.candidate.DOI}). Cite the published version if you used it.`);
    for (const n of v.notices) add(r.id, n.kind === "retraction" ? "retracted" : "notice", n.kind === "retraction" || n.kind === "withdrawal" ? "error" : "warning", `${n.label}${n.doi ? ` (${n.doi})` : ""}, reported by ${n.source}.`);
  }

  for (const [a, b] of findDuplicates(refs)) add(b, "duplicate", "warning", `Looks like a duplicate of ${a}.`);
  const ids = new Set(refs.map((r) => r.id));
  for (const k of new Set(opts.citedKeys ?? [])) if (!ids.has(k)) add(k, "cited-not-in-library", "error", `Cited as [@${k}] but not in the library.`);

  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((x, y) => order[x.severity] - order[y.severity] || x.refId.localeCompare(y.refId));
  return { checkedAt: now.toISOString(), total: refs.length, verified, findings, counts, limits: QUALITY_LIMITS };
}

/** Pull [@key] citation keys out of Markdown. */
export function citedKeys(markdown: string): string[] {
  const keys = new Set<string>();
  for (const m of markdown.matchAll(/\[([^\]]*@[^\]]*)\]/g)) for (const k of m[1]!.matchAll(/@([\w:.#$%&+?<>~/-]+)/g)) keys.add(k[1]!.replace(/[.,;:]+$/, ""));
  return [...keys];
}
