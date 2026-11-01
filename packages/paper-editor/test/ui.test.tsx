// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { MemoryCollection } from "@aether/research-core";
import type { Reference } from "@aether/citations";
import { PaperStore, type Paper } from "@aether/paper-editor";
import { PaperEditor } from "@aether/paper-editor/ui";

afterEach(cleanup);

const LIB = new Map<string, Reference>([["he2016", { id: "he2016", type: "article-journal", title: "Deep residual learning", author: [{ family: "He", given: "Kaiming" }], issued: { "date-parts": [[2016]] }, "container-title": "CVPR", DOI: "10.1/x" }]]);

describe("PaperEditor", () => {
  it("edits with live citations, records AI suggestions and exports", async () => {
    const store = new PaperStore(new MemoryCollection<Paper>());
    const p = await store.create({ templateId: "ieee-conference", title: "SAR ADC" });
    const exported: string[] = [];
    render(
      <PaperEditor
        paperId={p.id}
        client={store}
        library={LIB}
        saveDelay={5}
        assist={async (text) => ({ text: text.replace("teh", "the"), provider: "ollama", model: "llama3.2", auditId: "ai_1" })}
        onExport={(f) => exported.push(`${f.name}:${f.content.length > 0}`)}
      />,
    );
    const area = await screen.findByLabelText("Introduction text");
    fireEvent.change(area, { target: { value: "Residual nets help teh model [@he2016]." } });
    await waitFor(() => expect(screen.getByTestId("section-preview").innerHTML).toContain("[1]"));
    await waitFor(async () => expect((await store.get(p.id))!.sections[2]!.body).toContain("teh"));

    fireEvent.click(screen.getByRole("button", { name: "Grammar revision" }));
    await screen.findByRole("dialog", { name: "AI suggestion" });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(async () => expect((await store.get(p.id))!.sections[2]!.body).toBe("Residual nets help the model [@he2016]."));

    fireEvent.click(screen.getByRole("tab", { name: "AI use" }));
    expect((screen.getByLabelText("AI disclosure statement") as HTMLTextAreaElement).value).toContain("llama3.2 via AETHER for grammar revision in Introduction");

    fireEvent.change(screen.getByLabelText("Export"), { target: { value: "tex" } });
    expect(exported).toEqual(["main.tex:true"]);
  });
});
