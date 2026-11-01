import { describe, it, expect } from "vitest";
import { MemoryCollection } from "@aether/research-core";
import type { Reference } from "@aether/citations";
import { PaperStore, TEMPLATES, checkPaper, aiDisclosure, aiSummary, sentences, wordCount, readability, exportMarkdown, exportLatex, exportHtml, exportPandoc, markdownToLatex, type Paper } from "@aether/paper-editor";

const LIB = new Map<string, Reference>([
  ["he2016", { id: "he2016", type: "article-journal", title: "Deep residual learning", author: [{ family: "He", given: "Kaiming" }], issued: { "date-parts": [[2016]] }, "container-title": "CVPR", DOI: "10.1109/CVPR.2016.90" }],
  ["sedra2015", { id: "sedra2015", type: "book", title: "Microelectronic Circuits", author: [{ family: "Sedra", given: "Adel" }], issued: { "date-parts": [[2015]] }, publisher: "OUP" }],
  ["noyear", { id: "noyear", type: "article-journal", title: "Undated", author: [{ family: "Roe" }], "container-title": "J" }],
]);

function clock() {
  let t = Date.UTC(2026, 9, 29);
  return { now: () => new Date((t += 1000)) };
}

async function sample() {
  const store = new PaperStore(new MemoryCollection<Paper>(), clock());
  let p = await store.create({ templateId: "ieee-conference", title: "Low-Power SAR ADC", workspaceId: "ws_vlsi" });
  const [abs, , intro, related, method] = p.sections;
  await store.updateSection(p.id, abs!.id, { body: "We present a 10-bit SAR ADC achieving 9.1 ENOB." });
  await store.updateSection(p.id, intro!.id, { body: "Residual networks changed vision [@he2016]. Studies show that SAR ADCs dominate low-power designs. See [@ghost2020]." });
  await store.updateSection(p.id, related!.id, { body: "Transistor models follow [@sedra2015, p. 45; @he2016]." });
  await store.updateSection(p.id, method!.id, { body: "The comparator gain is $A = g_m r_o$ and\n\n$$\nP = C V^2 f\n$$\n\n- low *noise*\n- **fast** & small\n\n| a | b |\n|---|---|\n| 1 | 2 |" });
  p = await store.addReferences(p.id, ["he2016", "sedra2015", "noyear"]);
  return { store, p };
}

describe("templates and store", () => {
  it("every template has sections and a known style", () => {
    for (const t of TEMPLATES) {
      expect(t.sections.length).toBeGreaterThan(0);
      expect(["apa", "ieee", "mla", "chicago"]).toContain(t.style);
    }
  });
  it("creates from a template, edits, reorders, snapshots and restores", async () => {
    const { store, p } = await sample();
    expect(p.sections.map((s) => s.heading).slice(0, 4)).toEqual(["Abstract", "Index Terms", "Introduction", "Related Work"]);
    const withNew = await store.addSection(p.id, "Threats to Validity", { after: p.sections[6]!.id });
    expect(withNew.sections[7]!.heading).toBe("Threats to Validity");
    await store.moveSection(p.id, withNew.sections[7]!.id, -1);
    expect((await store.get(p.id))!.sections[6]!.heading).toBe("Threats to Validity");
    const snap = await store.snapshot(p.id, "v1");
    await store.updateSection(p.id, p.sections[2]!.id, { body: "rewritten" });
    const restored = await store.restore(p.id, snap.snapshots[0]!.at);
    expect(restored.sections[2]!.body).toContain("Residual networks");
    expect(restored.snapshots.map((s) => s.label)).toEqual(["v1", "Before restore"]);
    await expect(store.create({ templateId: "nope" })).rejects.toThrow();
  });
});

describe("checks", () => {
  it("finds unresolved, uncited, unsupported and incomplete references", async () => {
    const { p } = await sample();
    const issues = checkPaper(p, LIB);
    const codes = issues.map((i) => i.code);
    expect(issues.find((i) => i.code === "unresolved-citation")!.message).toContain("@ghost2020");
    expect(issues.find((i) => i.code === "uncited-reference")!.message).toContain("@noyear");
    expect(issues.find((i) => i.code === "unsupported-claim")!.excerpt).toBe("Studies show that SAR ADCs dominate low-power designs.");
    expect(codes).toContain("word-count");
    expect(codes).toContain("empty-section");
    expect(codes).not.toContain("no-citations");
  });
  it("sentence splitting respects abbreviations and decimals", () => {
    expect(sentences("Gain is 3.5 dB, e.g. at 1 GHz. Fig. 2 shows it. He et al. agree.")).toEqual(["Gain is 3.5 dB, e.g. at 1 GHz.", "Fig. 2 shows it.", "He et al. agree."]);
    expect(wordCount("The $x^2$ term [@he2016] is *small*.")).toBe(6);
    const r = readability("The circuit was designed by the team. It works well.");
    expect(r.sentences).toBe(2);
    expect(r.passiveRatio).toBe(0.5);
    expect(r.fleschReadingEase).toBeGreaterThan(50);
  });
  it("writes an honest AI disclosure", async () => {
    const { store, p } = await sample();
    expect(aiDisclosure(p)).toBe("No generative AI tools were used in preparing this manuscript.");
    const intro = p.sections[2]!;
    let q = await store.recordAi(p.id, { sectionId: intro.id, action: "Grammar revision", provider: "ollama", model: "llama3.2", accepted: true, charsBefore: 100, charsAfter: 98 }, "Revised intro [@he2016].");
    q = await store.recordAi(p.id, { sectionId: intro.id, action: "Clarity revision", provider: "ollama", model: "llama3.2", accepted: false, charsBefore: 98, charsAfter: 120 });
    expect(q.sections[2]!.body).toBe("Revised intro [@he2016].");
    expect(aiSummary(q.aiLog)).toEqual({ suggestions: 2, accepted: 1, charsChanged: 2 });
    expect(aiDisclosure(q)).toBe("The author(s) used llama3.2 via AETHER for grammar revision in Introduction. All AI suggestions were reviewed and edited by the author(s), who take full responsibility for the content.");
  });
});

describe("export", () => {
  it("markdown with IEEE numbering and bibliography", async () => {
    const { p } = await sample();
    const md = exportMarkdown(p, LIB);
    expect(md).toContain("Residual networks changed vision [1].");
    expect(md).toContain("See [?ghost2020].");
    expect(md).toContain("follow [1], [2]");
    expect(md).toMatch(/\[1\] K\. He, .*Deep residual learning/);
    expect(md).toMatch(/\[2\] A\. Sedra, \*Microelectronic Circuits\*/);
  });
  it("LaTeX via IEEEtran with \\cite and .bib", async () => {
    const { p } = await sample();
    const { tex, bib } = exportLatex({ ...p, authors: [{ name: "Kailash A", affiliation: "VIT Chennai" }] }, LIB);
    expect(tex).toContain("\\documentclass[conference]{IEEEtran}");
    expect(tex).toContain("\\IEEEauthorblockN{Kailash A}");
    expect(tex).toContain("\\begin{abstract}\nWe present a 10-bit SAR ADC achieving 9.1 ENOB.\n\\end{abstract}");
    expect(tex).toContain("Residual networks changed vision \\cite{he2016}.");
    expect(tex).toContain("\\cite{sedra2015,he2016}");
    expect(tex).toContain("\\bibliographystyle{IEEEtran}");
    expect(bib).toContain("@article{he2016,");
    expect(bib).toContain("@book{sedra2015,");
  });
  it("converts markdown constructs to LaTeX", () => {
    const t = markdownToLatex("Gain $A = g_m r_o$ & 50% *noise* **fast** `code` [link](https://x.org/a_b) [@k, p. 3]\n\n$$\nP = CV^2f\n$$\n\n1. one\n2. two\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(t).toContain("Gain $A = g_m r_o$ \\& 50\\% \\emph{noise} \\textbf{fast} \\texttt{code} \\href{https://x.org/a_b}{link} \\cite[p. 3]{k}");
    expect(t).toContain("\\[\nP = CV^2f\n\\]");
    expect(t).toContain("\\begin{enumerate}\n  \\item one\n  \\item two\n\\end{enumerate}");
    expect(t).toContain("\\begin{tabular}{ll}");
  });
  it("pandoc and HTML", async () => {
    const { p } = await sample();
    expect(exportPandoc(p)).toContain("csl: ieee.csl");
    expect(exportPandoc(p)).toContain("[@he2016]");
    const html = exportHtml(p, LIB);
    expect(html).toContain("<title>Low-Power SAR ADC</title>");
    expect(html).toContain('<ol class="numeric">');
    expect(html).not.toContain("<script");
  });
});
