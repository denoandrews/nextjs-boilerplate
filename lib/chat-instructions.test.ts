import { afterEach, describe, expect, it, vi } from "vitest";
import { buildChatInstructions, getMaxOutputTokens, municipalClock, timeZoneForSlug } from "./chat-instructions";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("municipal clock and instructions", () => {
  it("uses the America/Chicago calendar date, including before UTC midnight", () => {
    expect(timeZoneForSlug("oak-park-il")).toBe("America/Chicago");
    const clock = municipalClock("America/Chicago", new Date("2026-10-19T03:30:00.000Z"));
    expect(clock.iso).toBe("2026-10-18");
    expect(clock.label).toBe("Sunday, October 18, 2026");
  });

  it("tells Oak Park the date, how to rank records, and not to invent a weather tool", () => {
    const instructions = buildChatInstructions({
      municipalityName: "Village of Oak Park",
      slug: "oak-park-il",
      newsEnabled: true,
      now: new Date("2026-10-19T18:00:00.000Z"),
    });
    expect(instructions).toContain("Monday, October 19, 2026");
    expect(instructions).toContain("America/Chicago");
    expect(instructions).toContain("in the past");
    expect(instructions).toContain("Do not open with Yes or No");
    expect(instructions).toContain("general fund");
    expect(instructions).toContain("property tax levy is not the general fund");
    expect(instructions).toContain("$19,125,000");
    expect(instructions).toContain("not the general fund budget");
    expect(instructions).toContain("language of the latest user question");
    expect(instructions).toContain("previous question was Spanish");
    expect(instructions).toContain("put its exact URL");
    expect(instructions).toContain("Language for this turn: English.");
    expect(instructions).toContain("$114,695,709");
    expect(instructions).toContain("records do not include a future meeting");
    expect(instructions).toContain("vendor proposal");
    expect(instructions).toContain("https://www.oak-park.us/Building-Business/Building-Permits");
    expect(instructions).toContain("pickup day");
    expect(instructions).toContain("2020 Remedial Action Plan");
    expect(instructions).toContain("2017-09-18 agenda is older than a 2026-10-13 agenda");
    expect(instructions).toContain("Minutes dated 2025-05-06 are newer than a decision dated May 15, 2023");
    expect(instructions).toContain("file-search query must include 2026");
    expect(instructions).toContain("also include October");
    expect(instructions).toContain("not a parking provider");
    expect(instructions).toContain("100 square feet");
    expect(instructions).not.toContain("can still be the current revised code");
    expect(instructions).toContain("You do not have a weather tool");
    expect(instructions).toContain("https://www.oak-park.us/Services-Parking/Waste-Recycling/Garbage-Collection");
    expect(instructions).toContain("Oak Park, Illinois");
  });

  it("names Spanish when the latest question is Spanish", () => {
    const instructions = buildChatInstructions({
      municipalityName: "Village of Oak Park",
      slug: "oak-park-il",
      newsEnabled: true,
      question: "[TEST] ¿Cómo pago una multa de estacionamiento?",
    });
    expect(instructions).toContain("Language for this turn: Spanish.");
    expect(instructions).toContain("Write every sentence of the answer in Spanish.");
    expect(instructions).not.toContain("Language for this turn: English.");
  });

  it("does not give another municipality Oak Park's pages", () => {
    const instructions = buildChatInstructions({
      municipalityName: "Strawberry Point",
      slug: "strawberry-point-ia",
      newsEnabled: false,
      now: new Date("2026-10-19T18:00:00.000Z"),
    });
    expect(instructions).toContain("America/Chicago");
    expect(instructions).not.toContain("oak-park.us");
    expect(instructions).not.toContain("Wednesday Journal");
  });

  it("treats vote tallies and exhaustive lists as a sample, not a complete search", () => {
    const instructions = buildChatInstructions({
      municipalityName: "Village of Oak Park",
      slug: "oak-park-il",
      newsEnabled: true,
      question: "Find every time only two trustees voted together, both yes with everyone else no, or both no with everyone else yes.",
    });
    expect(instructions).toContain("this rule overrides rule 1");
    expect(instructions).toContain("records retrieved for this answer are only a sample");
    expect(instructions).toContain("about 16 snippets");
    expect(instructions).toContain("cannot give a complete list");
    expect(instructions).toContain("every time");
    expect(instructions).toContain("all votes where");
    expect(instructions).toContain("how many times");
    expect(instructions).toContain("matrix of votes");
    expect(instructions).toContain("strictly meet the user's stated criteria");
    expect(instructions).toContain("none were found in the retrieved records");
    expect(instructions).toContain("You cannot keep searching");
    expect(instructions).toContain("broader or later search");
    expect(instructions).toContain("fuller matrix");
    expect(instructions).toContain("email anyone");
    expect(instructions).toContain("tally must match the names");
    expect(instructions).toContain("6-1 vote has one person on the minority side");
    expect(instructions).toContain("two named nays");
    expect(instructions).toContain("unanimous vote, including a 7-0 or 6-0");
    expect(instructions).toContain("number of names on each side must equal the numbers in the split");
    expect(instructions).toContain("A 4-2 vote is not that case");
    expect(instructions).toContain("two named members voting yes");
    expect(instructions).toContain("every other member voting no");
    expect(instructions).toContain("unless the records retrieved for this turn support it");
    expect(instructions).toContain("say the correction plainly");
  });

  it("gives reasoning models a higher default output budget", () => {
    expect(getMaxOutputTokens("gpt-4.1-mini")).toBe(800);
    expect(getMaxOutputTokens("gpt-5.4-mini")).toBe(1600);
    vi.stubEnv("OPENAI_MAX_OUTPUT_TOKENS", "500");
    expect(getMaxOutputTokens("gpt-5.4-mini")).toBe(500);
    vi.stubEnv("OPENAI_MAX_OUTPUT_TOKENS", "9000");
    expect(getMaxOutputTokens("gpt-4.1-mini")).toBe(2000);
  });
});
