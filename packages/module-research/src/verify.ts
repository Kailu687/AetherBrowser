import type { Reference } from "@aether/citations";
import { dateParts, normalizeDoi } from "@aether/citations";
import { crossrefToReference, parseArxivAtom, parseArxivId, type CrossrefWork } from "@aether/sources";
import type { FieldDiff, VerificationRecord } from "./model.js";
import { openAlexByDoi, type ServiceCredentials } from "./discovery.js";
import { NetError, type LabNet } from "./net.js";
import { normalize, titleSimilarity } from "./text.js";

/**
 * Reference verification: does each reference point at a real, matching
 * record in a scholarly registry? The checker reports; it never edits the
 * user's reference. Corrections are offered as field diffs the user applies.
 *
 * Honest limits, also shown in the UI:
 * - "verified" means the identifier resolves to a record whose title, first
 *   author and year match. It does not check that the work supports the claim
 *   it is cited for.
 * - "unmatched" means we found no confident match. Books, standards, theses
 *   and grey literature are often missing from these registries.
 * - Retraction notices are only as complete as Crossref and OpenAlex data.
 */

type Notice = VerificationRecord["notices"][number];

interface CrossrefUpdate {
  type?: string;
  label?: string;
  DOI?: string;
  source?: string;
}

const NOTICE_KIND = (t = ""): Notice["kind"] => {
  const s = t.toLowerCase();
  if (s.includes("retract")) return "retraction";
  if (s.includes("concern")) return "expression-of-concern";
  if (s.includes("withdraw") || s.includes("removal")) return "withdrawal";
  if (s.includes("correct") || s.includes("erratum") || s.includes("corrigendum")) return "correction";
  return "other";
};

export function crossrefNotices(w: CrossrefWork & { "updated-by"?: CrossrefUpdate[]; relation?: Record<string, Array<{ id?: string }>> }): Notice[] {
  const out: Notice[] = [];
  for (const u of w["updated-by"] ?? []) {
    if (!u || typeof u !== "object") continue;
    out.push({ kind: NOTICE_KIND(u.type), label: String(u.label ?? u.type ?? "Update").slice(0, 200), doi: typeof u.DOI === "string" ? u.DOI : undefined, source: u.source === "retraction-watch" ? "Retraction Watch via Crossref" : "Crossref" });
  }
  for (const [rel, list] of Object.entries(w.relation ?? {})) {
    if (/retract|withdrawn/i.test(rel)) for (const r of list ?? []) out.push({ kind: NOTICE_KIND(rel), label: rel, doi: r.id, source: "Crossref" });
  }
  return out;
}

const year = (r: Reference) => dateParts(r.issued).year;
const firstFamily = (r: Reference) => normalize(r.author?.[0]?.family ?? r.author?.[0]?.literal ?? "");

/** Compare our reference with the registry's record. */
export function compareReferences(ours: Reference, reg: Reference): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const sim = titleSimilarity(ours.title, reg.title);
  if (ours.title && reg.title && sim < 0.9) diffs.push({ field: "title", ours: ours.title, registry: reg.title, severity: sim < 0.6 ? "error" : "warning" });
  const fa = firstFamily(ours);
  const fb = firstFamily(reg);
  if (fa && fb && fa !== fb && !fb.includes(fa) && !fa.includes(fb)) {
    const regAuthors = (reg.author ?? []).map((a) => normalize(a.family ?? a.literal ?? ""));
    // Author present but in a different position is a warning; absent is an error.
    diffs.push({ field: "author", ours: ours.author?.[0]?.family ?? ours.author?.[0]?.literal ?? "", registry: reg.author?.[0]?.family ?? reg.author?.[0]?.literal ?? "", severity: regAuthors.includes(fa) ? "warning" : "error" });
  }
  const ya = year(ours);
  const yb = year(reg);
  // Online-first vs print years commonly differ by one.
  if (ya && yb && Math.abs(Number(ya) - Number(yb)) > 0) diffs.push({ field: "issued", ours: String(ya), registry: String(yb), severity: Math.abs(Number(ya) - Number(yb)) > 1 ? "error" : "warning" });
  const ca = normalize(ours["container-title"] ?? "");
  const cb = normalize(reg["container-title"] ?? "");
  if (ca && cb && ca !== cb && titleSimilarity(ca, cb) < 0.7 && !cb.includes(ca) && !ca.includes(cb)) diffs.push({ field: "container-title", ours: ours["container-title"]!, registry: reg["container-title"]!, severity: "warning" });
  if (ours.volume && reg.volume && String(ours.volume) !== String(reg.volume)) diffs.push({ field: "volume", ours: String(ours.volume), registry: String(reg.volume), severity: "warning" });
  const pa = ours.page?.replace(/[–—-]+/g, "-");
  const pb = reg.page?.replace(/[–—-]+/g, "-");
  if (pa && pb && pa !== pb) diffs.push({ field: "page", ours: ours.page!, registry: reg.page!, severity: "warning" });
  return diffs;
}

export interface VerifyOptions {
  cred?: ServiceCredentials;
  /** Also query OpenAlex for retraction status of DOIs (one extra request each). */
  checkRetractions?: boolean;
  now?: () => Date;
}

function record(ref: Reference, rest: Omit<VerificationRecord, "id" | "createdAt" | "updatedAt" | "refId" | "checkedAt" | "notices" | "diffs"> & Partial<Pick<VerificationRecord, "notices" | "diffs">>, now: Date): VerificationRecord {
  const at = now.toISOString();
  return { id: ref.id, refId: ref.id, createdAt: at, updatedAt: at, checkedAt: at, diffs: [], notices: [], ...rest };
}

/** Verify one reference against the registries. Never throws for expected failures; returns a record with status "error" or "offline". */
export async function verifyReference(net: LabNet, ref: Reference, opts: VerifyOptions = {}): Promise<VerificationRecord> {
  const now = opts.now?.() ?? new Date();
  try {
    const doi = ref.DOI ? normalizeDoi(ref.DOI) : undefined;
    if (ref.DOI && !doi) return record(ref, { status: "not-found", message: `“${ref.DOI}” is not a valid DOI.`, registry: "crossref" }, now);
    if (doi) return await verifyDoi(net, ref, doi, opts, now);
    const arx = ref.archive_location && /arxiv/i.test(ref.archive ?? "") ? parseArxivId(String(ref.archive_location)) : ref.URL ? parseArxivId(ref.URL) : undefined;
    if (arx) return await verifyArxiv(net, ref, arx.id, now);
    return await searchForMatch(net, ref, opts, now);
  } catch (e) {
    if (e instanceof NetError && e.kind === "offline") return record(ref, { status: "offline", message: e.message }, now);
    return record(ref, { status: "error", message: (e as Error).message }, now);
  }
}

async function verifyDoi(net: LabNet, ref: Reference, doi: string, opts: VerifyOptions, now: Date): Promise<VerificationRecord> {
  const q = opts.cred?.mailto ? `?mailto=${encodeURIComponent(opts.cred.mailto)}` : "";
  let reg: Reference | undefined;
  let notices: Notice[] = [];
  let registry = "crossref";
  try {
    const body = await net.getJson<{ message?: CrossrefWork }>(`https://api.crossref.org/works/${encodeURIComponent(doi)}${q}`, { service: "crossref", purpose: "Verify reference", sent: doi });
    if (body?.message) {
      reg = crossrefToReference(body.message);
      notices = crossrefNotices(body.message as never);
    }
  } catch (e) {
    if (!(e instanceof NetError) || e.kind !== "not-found") throw e;
  }
  if (!reg) {
    // Not a Crossref DOI: ask doi.org (covers DataCite, mEDRA, ...).
    registry = "doi.org";
    try {
      const csl = await net.getJson<Reference>(`https://doi.org/${encodeURI(doi)}`, { service: "doi.org", purpose: "Verify reference", sent: doi, headers: { Accept: "application/vnd.citationstyles.csl+json" } });
      if (csl && typeof csl === "object" && (csl.title || csl.DOI)) reg = { ...csl, id: ref.id };
    } catch (e) {
      if (!(e instanceof NetError) || e.kind !== "not-found") throw e;
    }
  }
  if (!reg) return record(ref, { status: "not-found", registry, message: `The DOI ${doi} does not resolve at Crossref or doi.org. Check it for typos; a DOI that never resolves may have been invented.` }, now);
  if (opts.checkRetractions) {
    try {
      const oa = await openAlexByDoi(net, doi, opts.cred);
      if (oa?.isRetracted && !notices.some((n) => n.kind === "retraction")) notices.push({ kind: "retraction", label: "Marked as retracted", source: "OpenAlex" });
    } catch {
      // Retraction lookup is best effort; the main verification already succeeded.
    }
  }
  const diffs = compareReferences(ref, reg);
  const bad = diffs.some((d) => d.severity === "error");
  return record(
    ref,
    {
      status: diffs.length ? "mismatch" : "verified",
      registry,
      diffs,
      notices,
      candidate: diffs.length ? { ...reg, id: ref.id } : undefined,
      message: diffs.length
        ? bad
          ? "The DOI resolves to a different-looking record. Check that the DOI belongs to this work."
          : "The DOI resolves, with small differences from the registry record."
        : `Matches the ${registry === "crossref" ? "Crossref" : "doi.org"} record.`,
    },
    now,
  );
}

async function verifyArxiv(net: LabNet, ref: Reference, id: string, now: Date): Promise<VerificationRecord> {
  const xml = await net.getText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, { service: "arxiv", purpose: "Verify reference", sent: id });
  const [reg] = parseArxivAtom(xml);
  if (!reg || !reg.title || /^error$/i.test(reg.title)) return record(ref, { status: "not-found", registry: "arxiv", message: `arXiv has no record for ${id}.` }, now);
  const diffs = compareReferences(ref, reg);
  const notices: Notice[] = /withdrawn/i.test(reg.abstract ?? "") || /withdrawn/i.test(reg.note ?? "") ? [{ kind: "withdrawal", label: "The arXiv abstract says this paper was withdrawn", source: "arXiv" }] : [];
  const published = reg.DOI ? ` A published version has DOI ${reg.DOI}; consider citing it.` : "";
  return record(ref, { status: diffs.length ? "mismatch" : "verified", registry: "arxiv", diffs, notices, candidate: diffs.length || reg.DOI ? { ...reg, id: ref.id } : undefined, message: (diffs.length ? "Differs from the arXiv record." : "Matches the arXiv record.") + published }, now);
}

async function searchForMatch(net: LabNet, ref: Reference, opts: VerifyOptions, now: Date): Promise<VerificationRecord> {
  if (!ref.title) return record(ref, { status: "unmatched", message: "No DOI, arXiv id or title to check." }, now);
  const bib = [ref.title, ref.author?.[0]?.family ?? ref.author?.[0]?.literal, year(ref)].filter(Boolean).join(" ");
  const p = new URLSearchParams({ "query.bibliographic": bib, rows: "5" });
  if (opts.cred?.mailto) p.set("mailto", opts.cred.mailto);
  const body = await net.getJson<{ message?: { items?: CrossrefWork[] } }>(`https://api.crossref.org/works?${p}`, { service: "crossref", purpose: "Verify reference (search)", sent: bib });
  let best: { ref: Reference; sim: number } | undefined;
  for (const w of body?.message?.items ?? []) {
    if (!w?.DOI) continue;
    const cand = crossrefToReference(w);
    let sim = titleSimilarity(ref.title, cand.title);
    // Require the first author to agree when both have one.
    const fa = firstFamily(ref);
    const fb = firstFamily(cand);
    if (fa && fb && fa !== fb) sim -= 0.15;
    const ya = year(ref);
    const yb = year(cand);
    if (ya && yb && Math.abs(Number(ya) - Number(yb)) > 1) sim -= 0.15;
    if (!best || sim > best.sim) best = { ref: cand, sim };
  }
  if (best && best.sim >= 0.9) {
    return record(ref, { status: "candidate", registry: "crossref", similarity: Math.round(best.sim * 100) / 100, candidate: { ...best.ref, id: ref.id }, diffs: compareReferences(ref, best.ref), message: `Likely the same work as DOI ${best.ref.DOI}. Confirm before adding the DOI.` }, now);
  }
  const kind = ["book", "chapter", "thesis", "standard", "webpage", "report", "patent"].includes(ref.type) ? ` ${ref.type === "webpage" ? "Web pages" : "Books, theses, standards and reports"} are often not indexed there.` : "";
  return record(ref, { status: "unmatched", registry: "crossref", similarity: best ? Math.round(best.sim * 100) / 100 : undefined, message: `No confident match in Crossref. This does not mean the work does not exist; check it by hand.${kind}` }, now);
}

/** Apply selected registry fields onto the user's reference (the user picks which). */
export function applyCorrections(ours: Reference, registry: Reference, fields: Array<FieldDiff["field"]>): Reference {
  const next: Reference = structuredClone(ours);
  for (const f of fields) {
    if (f === "author") next.author = structuredClone(registry.author);
    else if (f === "issued") next.issued = structuredClone(registry.issued);
    else {
      const v = (registry as unknown as Record<string, unknown>)[f];
      if (v !== undefined) (next as unknown as Record<string, unknown>)[f] = v;
    }
  }
  return next;
}
