// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { MemoryCollection } from "@aether/research-core";
import { Notebook, type Note } from "@aether/notebook";
import { NotesPanel } from "@aether/notebook/ui";

afterEach(cleanup);

describe("NotesPanel", () => {
  it("captures thoughts, searches, edits with autosave and toggles tasks", async () => {
    const nb = new Notebook(new MemoryCollection<Note>());
    await nb.create({ body: "# Radar basics\n- [ ] FMCW chirp math $f_b = 2R S / c$", workspaceId: "ws1" });
    await nb.create({ body: "# Other workspace", workspaceId: "ws2" });
    render(<NotesPanel client={nb} workspaceId="ws1" activeTab={{ url: "https://example.org", title: "Example" }} saveDelay={10} />);
    await screen.findByText("Radar basics");
    expect(screen.queryByText("Other workspace")).toBeNull();

    fireEvent.change(screen.getByLabelText("Quick capture"), { target: { value: "idea: chirp slope" } });
    fireEvent.submit(screen.getByLabelText("Quick capture").closest("form")!);
    await screen.findByText(/^Inbox /);

    fireEvent.change(screen.getByLabelText("Search notes"), { target: { value: "fmcw" } });
    await waitFor(() => expect(screen.queryByText(/^Inbox /)).toBeNull());

    fireEvent.click(screen.getByText("Radar basics"));
    const preview = await screen.findByTestId("preview");
    await waitFor(() => expect(preview.innerHTML).toContain("katex"));
    const box = preview.querySelector<HTMLInputElement>("input.task")!;
    await act(async () => {
      fireEvent.click(box);
    });
    await waitFor(async () => expect((await nb.list({ workspaceId: "ws1" })).find((n) => n.title === "Radar basics")!.body).toContain("- [x] FMCW"));
    expect(screen.getByText("Saved")).toBeTruthy();
  });
});
