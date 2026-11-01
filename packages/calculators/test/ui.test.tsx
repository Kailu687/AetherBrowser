// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CalculatorPanel, Scratchpad } from "@aether/calculators/ui";

afterEach(cleanup);

describe("calculator UI", () => {
  it("scratchpad evaluates lines live, including unit phrases", () => {
    render(<Scratchpad initial={"x = 10k || 10k\nx * 2\n1 km to m\n1 +"} />);
    const items = screen.getByLabelText("Results").querySelectorAll("li");
    expect([...items].map((li) => li.textContent)).toEqual(["5 k", "10 k", "1000 m", "Unexpected end of expression"]);
    fireEvent.change(screen.getByLabelText("Calculator scratchpad"), { target: { value: "2^8" } });
    expect(screen.getByLabelText("Results").textContent).toBe("256");
  });
  it("calculator form accepts SI suffixes and shows errors", () => {
    render(<CalculatorPanel initialTab="tools" />);
    fireEvent.click(screen.getByRole("button", { name: /RC filter/ }));
    const form = screen.getByRole("form", { name: /RC filter/ });
    const [r, c] = form.querySelectorAll("input");
    fireEvent.change(r!, { target: { value: "1k" } });
    fireEvent.change(c!, { target: { value: "1u" } });
    expect(form.textContent).toContain("159.2 Hz");
    fireEvent.change(r!, { target: { value: "1k +" } });
    expect(screen.getByRole("alert").textContent).toMatch(/end of expression/);
  });
});
