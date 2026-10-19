import { describe, expect, it } from "vitest";
import { clarifyLevyAnswer } from "./answer-quality";

describe("general fund levy guard", () => {
  it("does not open with the levy contrast unless the user or history mentions it", () => {
    const body = "The FY2026 general fund total is $114,695,709.";
    const copied = `That figure is a property tax levy, not the general fund budget.\n\n${body}`;
    expect(clarifyLevyAnswer("What is the general fund budget?", copied)).toBe(body);
    expect(clarifyLevyAnswer("What is the general fund budget?", body)).toBe(body);
    const asked = clarifyLevyAnswer(
      "Is the $19,125,000 levy the general fund budget?",
      "The general fund budget is $19,125,000."
    );
    expect(asked.startsWith("That figure is a property tax levy, not the general fund budget.")).toBe(true);
    const fromHistory = clarifyLevyAnswer(
      "What is the general fund budget?",
      "The general fund budget is $19,125,000.",
      "The levy discussed earlier was $19,125,000."
    );
    expect(fromHistory.startsWith("That figure is a property tax levy, not the general fund budget.")).toBe(true);
  });

  it("leaves an answer that already distinguishes the levy", () => {
    const answer = "The records show a property tax levy of $19,125,000, which is not the general fund budget.";
    expect(clarifyLevyAnswer("What is the general fund budget?", answer)).toBe(answer);
  });

  it("does not rewrite a question that is not about the general fund", () => {
    const answer = "The levy is $19,125,000.";
    expect(clarifyLevyAnswer("When is the next board meeting?", answer)).toBe(answer);
  });
});
