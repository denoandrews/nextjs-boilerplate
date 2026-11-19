import { describe, expect, it } from "vitest";

import {
  citationsFromEvidence,
  draftResearchQueries,
  mergeEvidence,
  parsePlannerQueries,
  personName,
  recencyCutoff,
  researchModeEnabled,
  scoreEvidence,
  webResultIsRelevant,
  type EvidenceItem,
} from "./research";
import { officialWebDomains, webPassEnabled, webSearchDomains } from "./web-sources";

const NOW = new Date("2026-11-19T18:00:00.000Z");

function item(partial: Omit<EvidenceItem, "tier" | "rankScore">): EvidenceItem {
  return scoreEvidence(partial, partial.text, NOW);
}

describe("research queries", () => {
  it("is on for Oak Park unless the env flag turns it off", () => {
    expect(researchModeEnabled("oak-park-il", undefined)).toBe(true);
    expect(researchModeEnabled("strawberry-point-ia", undefined)).toBe(false);
    expect(researchModeEnabled("oak-park-il", "0")).toBe(false);
    expect(researchModeEnabled("strawberry-point-ia", "on")).toBe(true);
  });

  it("searches a person by office words without asserting a biography", () => {
    expect(personName("Who is Robert Milstein?")).toBe("Robert Milstein");
    expect(personName("Who is the village president?")).toBeNull();
    const queries = draftResearchQueries("Who is Robert Milstein?", NOW);
    expect(queries).toEqual([
      "Robert Milstein trustee",
      "Robert Milstein village board",
      "Robert Milstein roll call",
      "Robert Milstein budget",
      "Robert Milstein president",
    ]);
    expect(queries.join(" ")).not.toContain("former");
  });

  it("covers each recent budget year, parking changes, and a Lake Street contractor", () => {
    expect(draftResearchQueries("How has the village budget changed over the last three years?", NOW)).toEqual([
      "village budget FY2024 adopted expenditures",
      "village budget FY2025 adopted expenditures",
      "village budget FY2026 adopted expenditures",
      "reasons for village budget changes",
    ]);
    const parking = draftResearchQueries("What is the current overnight parking policy?", NOW).join(" ");
    expect(parking).toContain("2023");
    expect(parking).toContain("2024");
    const lake = draftResearchQueries(
      "What did the board decide about the Lake Street streetscape, how much did it cost, who was the contractor, and were there any change orders?",
      NOW,
    );
    expect(lake.some((query) => /construction contractor/i.test(query))).toBe(true);
    expect(recencyCutoff("What is the history of the Roosevelt Road TIF?", NOW)).toBeNull();
    expect(recencyCutoff("What is the current overnight parking policy?", NOW)).toBe(20241119);
  });

  it("reads planner JSON and ignores anything that is not a query list", () => {
    expect(parsePlannerQueries('```json\n{"queries":["Lake Street cost"]}\n```')).toEqual(["Lake Street cost"]);
    expect(parsePlannerQueries("I will answer instead.")).toEqual([]);
  });
});

describe("web evidence", () => {
  it("keeps the official site and newspapers on for Oak Park and lets an env flag turn them off", () => {
    expect(webSearchDomains("oak-park-il")).toEqual([
      "oakpark.com",
      "chicagotribune.com",
      "oak-park.us",
      "www.oak-park.us",
      "oak-park.legistar.com",
    ]);
    expect(officialWebDomains("oak-park-il")).toContain("oak-park.us");
    expect(officialWebDomains("oak-park-il")).toContain("www.oak-park.us");
    expect(officialWebDomains("oak-park-il")).toContain("oak-park.legistar.com");
    expect(webSearchDomains("strawberry-point-ia")).toEqual([]);
    expect(webPassEnabled("oak-park-il", undefined)).toBe(true);
    expect(webPassEnabled("oak-park-il", "off")).toBe(false);
    expect(webPassEnabled("strawberry-point-ia", undefined)).toBe(false);
  });

  it("drops website hits that are not about the question", () => {
    const parking = "What is the current overnight parking policy?";
    expect(webResultIsRelevant(parking, "The farmers market opens on Saturday in the village.")).toBe(false);
    expect(webResultIsRelevant(parking, "The overnight parking permit fee changed for 2024 permits.")).toBe(true);
    expect(webResultIsRelevant("Who is Robert Milstein?", "A page about water bills and parking permits.")).toBe(false);
    expect(webResultIsRelevant("Who is Robert Milstein?", "Board listing for Robert Milstein.")).toBe(true);
  });

  it("ranks official records and the official website above newspaper reporting", () => {
    const merged = mergeEvidence([
      item({
        id: "https://www.oakpark.com/story",
        kind: "newspaper",
        filename: "Wednesday Journal",
        url: "https://www.oakpark.com/story",
        text: "A newspaper story about the budget.",
        score: 0.99,
      }),
      item({
        id: "https://www.oak-park.us/board",
        kind: "official",
        filename: "Village website",
        url: "https://www.oak-park.us/board",
        text: "Official board page.",
        score: 0.4,
      }),
      item({
        id: "file-minutes",
        kind: "record",
        filename: "minutes.pdf",
        text: "Minutes of the vote.",
        documentType: "minutes",
        score: 0.45,
      }),
    ]);
    expect(merged.map((entry) => entry.kind)).toEqual(["record", "official", "newspaper"]);
    const citations = citationsFromEvidence("The board voted. [2]", merged);
    expect(citations.map((citation) => citation.fileId)).toEqual(["https://www.oak-park.us/board"]);
    expect(citations[0].marker).toBe("[Official 2]");
  });
});
