import { describe, it, expect } from "vitest";
import { parseBibtex, importBibtex, exportBibtex, referenceToBibtex, generateKey, decodeLatex, exportRis, importRis } from "@aether/citations";
import { journal, book, preprint } from "./fixtures";

const SAMPLE = String.raw`
@string{tpami = "IEEE Trans. Pattern Anal."}
% a comment line
@comment{ignored @article{x, title={no}} }
@article{gödel1931,
  author = {G{\"o}del, Kurt and Erd\H{o}s, Paul and {IEEE Working Group}},
  title  = {On {Formally} Undecidable Propositions -- Part {I}},
  journal = tpami # " Suppl.",
  year = 1931, month = mar,
  volume = "38", pages = {173--198},
  doi = {https://doi.org/10.1007/BF01700692},
}
@inproceedings{broken, title = {missing close
@misc{arxivpaper,
  author = {Vaswani, Ashish},
  title = {Attention},
  eprint = {1706.03762}, archivePrefix = {arXiv}, year = {2017}
}
@phdthesis{t1, author={Doe, Jane}, title={Thesis}, school={IIT Madras}, year={2024}}
`;

describe("BibTeX", () => {
  it("parses macros, concatenation, accents and recovers from errors", () => {
    const { entries, errors } = parseBibtex(SAMPLE);
    expect(entries.map((e) => e.key)).toEqual(["gödel1931", "arxivpaper", "t1"]);
    expect(errors).toHaveLength(1);
    const { references } = importBibtex(SAMPLE);
    const g = references[0]!;
    expect(g.author).toEqual([{ family: "Gödel", given: "Kurt" }, { family: "Erdős", given: "Paul" }, { literal: "IEEE Working Group" }]);
    expect(g.title).toBe("On Formally Undecidable Propositions – Part I");
    expect(g["container-title"]).toBe("IEEE Trans. Pattern Anal. Suppl.");
    expect(g.issued).toEqual({ "date-parts": [[1931, 3]] });
    expect(g.page).toBe("173–198");
    expect(g.DOI).toBe("10.1007/BF01700692");
    expect(references[1]).toMatchObject({ archive: "arXiv", archive_location: "1706.03762", type: "article" });
    expect(references[2]).toMatchObject({ type: "thesis", publisher: "IIT Madras", genre: "Doctoral dissertation" });
  });

  it("round-trips through export and import", () => {
    const out = exportBibtex([journal, book, preprint]);
    expect(out).toContain("@article{he2016deep,");
    expect(out).toContain("pages = {770--778}");
    expect(out).toContain("month = jun");
    expect(out).toContain("archiveprefix = {arXiv}");
    const back = importBibtex(out).references;
    expect(back[0]).toMatchObject({ title: journal.title, volume: "38", issue: "4", DOI: journal.DOI, author: journal.author });
    expect(back[1]).toMatchObject({ title: book.title, edition: "7", publisher: book.publisher });
  });

  it("protects acronyms and escapes specials", () => {
    const s = referenceToBibtex({ id: "k", type: "article-journal", title: "A CMOS LNA & pH sensor: 50% better" });
    expect(s).toContain("title = {A {CMOS} {LNA} \\& {pH} sensor: 50\\% better}");
  });

  it("decodes LaTeX", () => {
    expect(decodeLatex("Schr\\\"{o}dinger \\& {\\'E}cole --- na\\\"{\\i}ve")).toBe("Schrödinger & École — naïve");
  });

  it("generates unique keys", () => {
    const taken = new Set(["vaswani2017attention"]);
    expect(generateKey(preprint, taken)).toBe("vaswani2017attentiona");
    expect(generateKey({ author: [{ family: "Gödel" }], title: "The theory of everything", issued: undefined })).toBe("godelndtheory");
  });
});

describe("RIS", () => {
  it("round-trips", () => {
    const ris = exportRis([journal, book]);
    expect(ris).toContain("TY  - JOUR");
    expect(ris).toContain("SP  - 770");
    const back = importRis(ris);
    expect(back[0]).toMatchObject({ id: "he2016deep", type: "article-journal", page: "770–778", DOI: journal.DOI, issued: { "date-parts": [[2016, 6]] } });
    expect(back[0]!.author![0]).toEqual({ family: "He", given: "Kaiming" });
    expect(back[1]).toMatchObject({ type: "book", publisher: book.publisher });
  });
});
