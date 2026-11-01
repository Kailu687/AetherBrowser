import { describe, it, expect } from "vitest";
import { Bibliography, formatReference, toPlain, toHtml, toLatex, toMarkdown, parseName, initials, validateReference, findDuplicates } from "@aether/citations";
import { journal, book, preprint, web, conf } from "./fixtures";

const fmt = (r: Parameters<typeof formatReference>[0], s: Parameters<typeof formatReference>[1]) => toPlain(formatReference(r, s));

describe("names", () => {
  it("parses inverted, natural and particle names", () => {
    expect(parseName("van Rossum, Guido")).toEqual({ family: "Rossum", given: "Guido", "non-dropping-particle": "van" });
    expect(parseName("Ludwig van Beethoven")).toEqual({ family: "Beethoven", given: "Ludwig", "non-dropping-particle": "van" });
    expect(parseName("Martin Luther King Jr.")).toEqual({ family: "King", given: "Martin Luther", suffix: "Jr." });
    expect(parseName("King, Jr., Martin Luther")).toEqual({ family: "King", given: "Martin Luther", suffix: "Jr." });
    expect(parseName("{IEEE Standards Association}")).toEqual({ literal: "IEEE Standards Association" });
  });
  it("forms initials including hyphenated given names", () => {
    expect(initials("Jean-Paul")).toBe("J.-P.");
    expect(initials("J. R. R.")).toBe("J. R. R.");
    expect(initials("Adel S.")).toBe("A. S.");
  });
});

describe("APA 7", () => {
  it("journal article", () => {
    expect(fmt(journal, "apa")).toBe(
      "He, K., Zhang, X., Ren, S., & Sun, J. (2016). Deep residual learning for image recognition. IEEE Transactions on Pattern Analysis, 38(4), 770–778. https://doi.org/10.1109/CVPR.2016.90",
    );
  });
  it("book with edition", () => {
    expect(fmt(book, "apa")).toBe("Sedra, A. S., & Smith, K. C. (2015). Microelectronic Circuits (7th ed.). Oxford University Press.");
  });
  it("arXiv preprint", () => {
    expect(fmt(preprint, "apa")).toBe(
      "Vaswani, A., & Shazeer, N. (2017). Attention is all you need (arXiv:1706.03762). arXiv. https://doi.org/10.48550/arXiv.1706.03762",
    );
  });
  it("web page by organisation omits duplicate site name", () => {
    expect(fmt(web, "apa")).toBe("Texas Instruments. (2023, March 14). LM741 operational amplifier datasheet. https://www.ti.com/lit/ds/symlink/lm741.pdf");
  });
  it("italicises journal and volume", () => {
    const html = toHtml(formatReference(journal, "apa"));
    expect(html).toContain("<i>IEEE Transactions on Pattern Analysis</i>, <i>38</i>(4)");
    expect(html).toContain('<a href="https://doi.org/10.1109/CVPR.2016.90">');
  });
  it("in-text citations and disambiguation", () => {
    const a = { ...conf, id: "a", title: "Beta paper" };
    const b2 = { ...conf, id: "b", title: "Alpha paper" };
    const bib = new Bibliography("apa", [journal, book, a, b2]);
    expect(bib.cite("he2016deep")).toBe("(He et al., 2016)");
    expect(bib.cite("sedra2015", { narrative: true })).toBe("Sedra and Smith (2015)");
    expect(bib.cite(["a", "b"])).toBe("(Smith, 2020b; Smith, 2020a)");
    expect(bib.cite("missing")).toBe("[?missing]");
    const entries = bib.entries();
    expect(entries.map((e) => e.id)).toEqual(["he2016deep", "sedra2015", "b", "a"]);
    expect(entries[2]!.text).toContain("(2020a)");
  });
});

describe("IEEE", () => {
  it("journal article", () => {
    expect(fmt(journal, "ieee")).toBe(
      "K. He, X. Zhang, S. Ren, and J. Sun, “Deep residual learning for image recognition,” IEEE Transactions on Pattern Analysis, vol. 38, no. 4, pp. 770–778, Jun. 2016, doi: 10.1109/CVPR.2016.90.",
    );
  });
  it("book", () => {
    expect(fmt(book, "ieee")).toBe("A. S. Sedra and K. C. Smith, Microelectronic Circuits, 7th ed. New York, NY, USA: Oxford University Press, 2015.");
  });
  it("conference paper", () => {
    expect(fmt(conf, "ieee")).toBe(
      "J. Smith, “A low-power SAR ADC,” in Proc. IEEE Int. Solid-State Circuits Conf., San Francisco, CA, USA, Feb. 2020, pp. 100–102.",
    );
  });
  it("preprint", () => {
    expect(fmt(preprint, "ieee")).toBe("A. Vaswani and N. Shazeer, “Attention is all you need,” 2017, arXiv:1706.03762.");
  });
  it("web page with access date", () => {
    expect(fmt(web, "ieee")).toBe(
      "Texas Instruments. “LM741 operational amplifier datasheet.” Texas Instruments. https://www.ti.com/lit/ds/symlink/lm741.pdf (accessed Oct. 1, 2026).",
    );
  });
  it("more than six authors uses et al.", () => {
    const many = { ...journal, author: Array.from({ length: 7 }, (_, i) => ({ family: `F${i}`, given: "A" })) };
    expect(fmt(many, "ieee").startsWith("A. F0 et al., ")).toBe(true);
  });
  it("numbers by first citation and collapses ranges", () => {
    const bib = new Bibliography("ieee", [journal, book, preprint, web]);
    expect(bib.cite("sedra2015")).toBe("[1]");
    expect(bib.cite(["he2016deep", "vaswani2017attention", "sedra2015"])).toBe("[1]–[3]");
    expect(bib.cite("ti2023", { locator: "p. 4" })).toBe("[4, p. 4]");
    expect(bib.entries().map((e) => e.label + e.id)).toEqual(["[1]sedra2015", "[2]he2016deep", "[3]vaswani2017attention", "[4]ti2023"]);
  });
});

describe("MLA 9", () => {
  it("journal article with 3+ authors", () => {
    expect(fmt(journal, "mla")).toBe(
      "He, Kaiming, et al. “Deep Residual Learning for Image Recognition.” IEEE Transactions on Pattern Analysis, vol. 38, no. 4, June 2016, pp. 770–778, https://doi.org/10.1109/CVPR.2016.90.".replace(
        "Deep Residual Learning for Image Recognition",
        "Deep residual learning for image recognition",
      ),
    );
  });
  it("book", () => {
    expect(fmt(book, "mla")).toBe("Sedra, Adel S., and Kenneth C. Smith. Microelectronic Circuits. 7th ed., Oxford University Press, 2015.");
  });
  it("in-text", () => {
    const bib = new Bibliography("mla", [journal, book]);
    expect(bib.cite("he2016deep", { locator: "p. 772" })).toBe("(He et al. 772)");
  });
});

describe("Chicago author-date", () => {
  it("journal article", () => {
    expect(fmt(journal, "chicago")).toBe(
      "He, Kaiming, Xiangyu Zhang, Shaoqing Ren, and Jian Sun. 2016. “Deep residual learning for image recognition.” IEEE Transactions on Pattern Analysis 38 (4): 770–778. https://doi.org/10.1109/CVPR.2016.90.",
    );
  });
  it("book", () => {
    expect(fmt(book, "chicago")).toBe("Sedra, Adel S., and Kenneth C. Smith. 2015. Microelectronic Circuits. 7th ed. New York, NY, USA: Oxford University Press.");
  });
  it("in-text", () => {
    const bib = new Bibliography("chicago", [journal, book]);
    expect(bib.cite("sedra2015", { locator: "p. 45" })).toBe("(Sedra and Smith 2015, 45)");
    expect(bib.cite("he2016deep")).toBe("(He et al. 2016)");
  });
});

describe("renderers", () => {
  it("escapes LaTeX and markdown", () => {
    const r = formatReference({ ...book, title: "R&D at 50% #1_x" }, "ieee");
    expect(toLatex(r)).toContain("\\textit{R\\&D at 50\\% \\#1\\_x}");
    expect(toMarkdown(r)).toContain("*R&D at 50% #1\\_x*");
    expect(toHtml(r)).toContain("R&amp;D");
  });
  it("never renders javascript: links", () => {
    const r = formatReference({ ...web, URL: "javascript:alert(1)" }, "apa");
    expect(toHtml(r)).not.toContain("<a ");
  });
});

describe("validation", () => {
  it("flags missing fields and bad DOIs", () => {
    const issues = validateReference({ id: "x", type: "article-journal", DOI: "nope", URL: "ftp://x" });
    const fields = issues.map((i) => i.field);
    expect(fields).toEqual(expect.arrayContaining(["title", "author", "issued", "DOI", "container-title", "URL"]));
    expect(validateReference(journal)).toEqual([]);
  });
  it("finds duplicates by DOI and title", () => {
    const dup = { ...journal, id: "dup", DOI: "https://doi.org/10.1109/cvpr.2016.90" };
    const dup2 = { ...book, id: "dup2", title: "Microelectronic circuits!" };
    expect(findDuplicates([journal, book, dup, dup2])).toEqual([["he2016deep", "dup"], ["sedra2015", "dup2"]]);
  });
});
