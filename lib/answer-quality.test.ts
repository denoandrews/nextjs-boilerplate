import { describe, expect, it } from "vitest";
import { clarifyLevyAnswer } from "./answer-quality";

describe("general fund levy guard", () => {
  it("says a levy is not the general fund budget when the answer still treats it as one", () => {
    const answer = clarifyLevyAnswer(
      "What is the general fund budget?",
      "The general fund budget is the property tax levy of $19,125,000."
    );
    expect(answer.startsWith("That figure is a property tax levy, not the general fund budget.")).toBe(true);
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
