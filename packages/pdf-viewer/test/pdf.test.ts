import { describe, it, expect, beforeAll } from "vitest";
import { configurePdfEngine, PdfDocument, PdfError, parsePdfDate, referenceFromPdf, zoomIn, zoomOut, fitWidth, visiblePages, parsePageRange } from "@aether/pdf-viewer";
import { makePdf } from "./make-pdf";

beforeAll(() => {
  // Node has no DOM worker; the legacy build runs with a fake worker in-process.
  configurePdfEngine({ load: () => import("pdfjs-dist/legacy/build/pdf.mjs") as never });
});

const PDF = () =>
  makePdf(
    [
      ["A Low-Noise Amplifier for 5G Receivers", "Priya Kumar and Rahul Rao", "doi: 10.1109/TCSI.2023.1234567"],
      ["Results show the noise figure is 1.2 dB.", "The noise floor drops with bias."],
    ],
    { Title: "Microsoft Word - lna_final.docx", Author: "Priya Kumar and Rahul Rao", CreationDate: "D:20230115103000+05'30'" },
  );

describe("PdfDocument", () => {
  it("opens, extracts text, searches and reads metadata", async () => {
    const doc = await PdfDocument.open(PDF());
    expect(doc.numPages).toBe(2);
    expect(doc.sourceId).toMatch(/^pdf:[0-9a-f]+$/);
    expect(await doc.pageText(2)).toContain("noise figure is 1.2 dB");
    const hits = await doc.search("NOISE");
    expect(hits.map((h) => h.page)).toEqual([1, 2, 2]);
    expect(hits[1]!.snippet).toContain("noise figure");
    const info = await doc.info();
    expect(info.author).toBe("Priya Kumar and Rahul Rao");
    expect(info.creationDate?.toISOString()).toBe("2023-01-15T05:00:00.000Z");
    expect(await doc.pageSize(1)).toEqual({ width: 612, height: 792 });
    expect(await doc.outline()).toEqual([]);
    await expect(doc.pageText(3)).rejects.toBeInstanceOf(PdfError);
    await doc.close();
  });

  it("builds a reference, ignoring junk titles", async () => {
    const doc = await PdfDocument.open(PDF());
    const { reference, doi } = await referenceFromPdf(doc, "lna.pdf");
    expect(doi).toBe("10.1109/TCSI.2023.1234567");
    expect(reference).toMatchObject({
      id: "kumar2023low",
      title: "A Low-Noise Amplifier for 5G Receivers",
      author: [{ family: "Kumar", given: "Priya" }, { family: "Rao", given: "Rahul" }],
      issued: { "date-parts": [[2023]] },
    });
    await doc.close();
  });

  it("reports invalid files clearly", async () => {
    await expect(PdfDocument.open(new TextEncoder().encode("not a pdf at all"))).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("viewer math", () => {
  it("zoom steps, fit and page ranges", () => {
    expect(zoomIn(1)).toBe(1.1);
    expect(zoomOut(1)).toBe(0.9);
    expect(zoomIn(5)).toBe(5);
    expect(fitWidth(612, 636)).toBe(1);
    expect(parsePageRange("1-3, 5, 9-, x, 0", 10)).toEqual([1, 2, 3, 5, 9, 10]);
    expect(parsePdfDate("D:2021")?.getUTCFullYear()).toBe(2021);
    expect(parsePdfDate("garbage")).toBeUndefined();
  });
  it("computes visible pages with overscan", () => {
    const heights = Array(10).fill(1000);
    expect(visiblePages(heights, 0, 800).first).toBe(1);
    expect(visiblePages(heights, 0, 800).last).toBe(2);
    const mid = visiblePages(heights, 5060, 800);
    expect([mid.first, mid.last]).toEqual([5, 7]);
  });
});
