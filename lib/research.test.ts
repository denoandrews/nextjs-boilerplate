import { describe, expect, it } from "vitest";

import {
  alignCitations,
  contractorQueries,
  dateWindowAround,
  descriptionNearLegislativeId,
  draftResearchQueries,
  filterNewsEvidence,
  formatEvidence,
  idotEvidenceIsRelevant,
  legislativeIdQueries,
  legislativeIds,
  legislativeQueryVariants,
  legislativeResolutionQueries,
  mergeEvidence,
  missingPartQueries,
  newsEvidenceIsRelevant,
  parsePlannerQueries,
  personName,
  RESEARCH_PLANNER_INSTRUCTIONS,
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
    expect(parking).toMatch(/motion/);
    expect(parking).toMatch(/approved/);
    expect(parking).toMatch(/adopted/);
    const lake = draftResearchQueries(
      "What did the board decide about the Lake Street streetscape, how much did it cost, who was the contractor, and were there any change orders?",
      NOW,
    );
    expect(lake.some((query) => /construction contractor/i.test(query))).toBe(true);
    expect(recencyCutoff("What is the history of the Roosevelt Road TIF?", NOW)).toBeNull();
    expect(recencyCutoff("What is the current overnight parking policy?", NOW)).toBe(20231119);
    expect(draftResearchQueries("[TEST] Who is Robert Milstein?", NOW)[0]).toBe("Robert Milstein trustee");
    const gaps = missingPartQueries(
      "What did the board decide about the Lake Street streetscape, who was the contractor?",
      "Thomas Engineering Group handled the design.",
    );
    expect(gaps.some((query) => /construction (?:contract|bid)/i.test(query))).toBe(true);
    expect(missingPartQueries(
      "who was the contractor?",
      "The construction contract was awarded to R.W. Duntemann Co.",
    )).toEqual([]);
    const parkingGaps = missingPartQueries(
      "What is the current overnight parking policy?",
      "Overnight parking is banned from 2:30 a.m. to 6:00 a.m. unless a permit is used.",
    );
    expect(parkingGaps.join(" ")).toContain("2023");
    expect(parkingGaps.join(" ")).toContain("2024");
    expect(parkingGaps.join(" ")).toContain("ordinance");
    expect(parkingGaps.join(" ")).not.toContain("ORD 23-118");
  });

  it("reads planner JSON and ignores anything that is not a query list", () => {
    expect(parsePlannerQueries('```json\n{"queries":["Lake Street cost"]}\n```')).toEqual(["Lake Street cost"]);
    expect(parsePlannerQueries("I will answer instead.")).toEqual([]);
    expect(RESEARCH_PLANNER_INSTRUCTIONS).toContain("motion");
    expect(RESEARCH_PLANNER_INSTRUCTIONS).toContain("approved");
    expect(RESEARCH_PLANNER_INSTRUCTIONS).toContain("adopted");
    expect(RESEARCH_PLANNER_INSTRUCTIONS).toContain("agenda");
    expect(RESEARCH_PLANNER_INSTRUCTIONS).toContain("contractor");
    expect(RESEARCH_PLANNER_INSTRUCTIONS).toContain("letting");
  });

  it("detects legislative IDs and searches the subject next to them", () => {
    expect(legislativeIds("ORD 23-118 and Ord. 23-118 and RES 24-12 and MOT 24-142").map((id) => id.canonical)).toEqual([
      "ORD 23-118",
      "RES 24-12",
      "MOT 24-142",
    ]);
    expect(legislativeIds("Ordinance 23-118")).toEqual([]);
    expect(legislativeIdQueries({ kind: "ORD", number: "23-118", canonical: "ORD 23-118" })).toEqual([
      "ORD 23-118",
      "Ord. 23-118",
      "Ordinance 23-118",
    ]);
    expect(legislativeIdQueries({ kind: "MOT", number: "24-142", canonical: "MOT 24-142" })).toContain("Motion 24-142");
    const agenda = "F. ORD 23-118 Reduced Parking Permit Fee Program expansion to affordable-housing sites. Second Reading and Adoption";
    expect(descriptionNearLegislativeId(agenda, { kind: "ORD", number: "23-118", canonical: "ORD 23-118" }))
      .toContain("Reduced Parking Permit Fee Program");
    expect(descriptionNearLegislativeId("The fee program expanded to affordable-housing sites.", { kind: "ORD", number: "23-118", canonical: "ORD 23-118" }))
      .toBeNull();
    const motion = "MOT 24-142 Zones Y1/Y2 overnight permit frontages";
    expect(descriptionNearLegislativeId(motion, { kind: "MOT", number: "24-142", canonical: "MOT 24-142" })).toContain("Y1/Y2");
    const window = dateWindowAround(20240411);
    expect(window.start).toBeLessThanOrEqual(20240311);
    expect(window.end).toBeGreaterThanOrEqual(20240411);

    const indexHit = item({
      id: "file-agenda",
      kind: "record",
      filename: "2023-12-04_VillageBoard_agenda.docx",
      documentType: "agenda",
      recordDate: 20231204,
      text: agenda,
      score: 0.8,
    });
    const body = item({
      id: "file-ordinance",
      kind: "record",
      filename: "2023-12-04_VillageBoard__08_Ordinance.docx",
      documentType: "ordinance",
      recordDate: 20231204,
      text: "Reduced Parking Permit Fee Program expansion to affordable-housing sites.",
      score: 0.9,
    });
    const followUps = legislativeResolutionQueries([body, indexHit]);
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.id).toBe("ORD 23-118");
    expect(followUps[0]?.query).toContain("affordable-housing");
    expect(followUps[0]?.recordDate).toBe(20231204);
    expect(followUps[0]?.dateStart).toBeLessThanOrEqual(20231204);
    expect(followUps[0]?.dateEnd).toBeGreaterThanOrEqual(20231204);
    expect(legislativeQueryVariants("What ordinance changed overnight parking?").join(" ")).toMatch(/motion approved/);
    expect(legislativeQueryVariants("What ordinance changed overnight parking?").join(" ")).toMatch(/adopted/);
  });

  it("asks for the construction award, not only the design consultant", () => {
    const question = "Who was the contractor for the Lake Street streetscape?";
    const queries = contractorQueries(question).join(" ");
    expect(queries).toContain("Lake Street streetscape contract awarded");
    expect(queries).toContain("construction contractor bid award");
    expect(queries).toContain("awarded to");
    expect(queries).toContain("budget explanation");
    expect(queries).toContain("IDOT letting");
    expect(queries).toContain("contract awarded IDOT bid");
    expect(queries).toContain("Section awarded to");
    expect(contractorQueries("What is the village population?")).toEqual([]);
    expect(draftResearchQueries(question, NOW).some((query) => /IDOT letting/i.test(query))).toBe(true);
    const design = scoreEvidence({
      id: "design",
      kind: "record",
      filename: "design-amendment.pdf",
      text: "Thomas Engineering Group, the design consultant, amended the engineering contract.",
      score: 0.95,
    }, question, NOW);
    const build = scoreEvidence({
      id: "build",
      kind: "record",
      filename: "budget-explanation.pdf",
      text: "IDOT awarded the construction contract to R.W. Duntemann Co. for $10,557,783.",
      score: 0.6,
    }, question, NOW);
    expect(build.rankScore).toBeGreaterThan(design.rankScore);
    const sewer = scoreEvidence({
      id: "sewer",
      kind: "record",
      filename: "sewer-award.pdf",
      text: "The Lake Street sewer contract was awarded to Trine Construction, the low bidder.",
      score: 0.9,
    }, question, NOW);
    const streetscape = scoreEvidence({
      id: "streetscape",
      kind: "record",
      filename: "2021-03-15_VillageBoard__08_Ordinance_Amendment_Detailed_Bud_Explanations.pdf",
      text: "IDOT awarded the Lake Street streetscape construction contract to R.W. Duntemann Co. for $10,557,783.",
      score: 0.55,
    }, question, NOW);
    expect(streetscape.rankScore).toBeGreaterThan(sewer.rankScore);
    expect(streetscape.rankScore).toBeGreaterThan(design.rankScore);
    expect(contractorQueries(question).join(" ")).toContain("low bidder");
    expect(idotEvidenceIsRelevant(question, "https://webapps1.dot.illinois.gov/WCP/Letting/128-61F36")).toBe(false);
    expect(idotEvidenceIsRelevant(
      question,
      "IDOT awarded the Lake Street streetscape, Section 16-00264-00-PV, to R.W. Duntemann Co.",
    )).toBe(true);
  });

  it("uses one citation per file and drops an empty missing-section heading", () => {
    const budget = [
      item({ id: "file-budget", kind: "record", filename: "fy26-budget-book.pdf", text: "FY2024 spending.", score: 0.8 }),
      item({ id: "file-budget-chunk", kind: "record", filename: "fy26-budget-book.pdf", text: "FY2026 spending rose.", score: 0.7 }),
      item({
        id: "https://www.oakpark.com/budget",
        kind: "newspaper",
        filename: "Wednesday Journal",
        url: "https://www.oakpark.com/budget",
        text: "The village drew on reserves.",
        score: 0.4,
      }),
    ];
    const aligned = alignCitations("FY2024 spending. [1] FY2026 spending. [2]\n\nWhat I couldn't find.\n\n[3]", budget);
    expect(aligned.answer).toBe("FY2024 spending. [1] FY2026 spending. [1]");
    expect(aligned.citations.map((citation) => citation.fileId)).toEqual(["file-budget"]);
    const named = alignCitations("FY2024 spending. [1]\n\nWhat I couldn't find.\n\nThe 2020 levy was not in the packet.", budget);
    expect(named.answer).toContain("What I couldn't find");
    expect(named.answer).toContain("2020 levy");
  });
});

describe("web evidence", () => {
  it("keeps the official site and newspapers on for Oak Park and lets an env flag turn them off", () => {
    expect(webSearchDomains("oak-park-il")).toEqual([
      "oakpark.com",
      "www.oakpark.com",
      "chicagotribune.com",
      "www.chicagotribune.com",
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
    expect(webResultIsRelevant("[TEST] Who is Robert Milstein?", "Wednesday Journal profile of Milstein.")).toBe(true);
    expect(webResultIsRelevant("What is the current overnight parking policy?", "www.oakpark.com reported a parking fee change.")).toBe(true);
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
    const aligned = alignCitations("The board voted. [2] Then the minutes. [3]", merged);
    expect(aligned.answer).toBe("The board voted. [1] Then the minutes. [2]");
    expect(aligned.answer).not.toContain("Wednesday Journal reported");
    expect(aligned.citations.map((citation) => citation.marker)).toEqual(["[1]", "[2]"]);
    expect(aligned.citations.map((citation) => citation.fileId)).toEqual([
      "https://www.oak-park.us/board",
      "https://www.oakpark.com/story",
    ]);
  });

  it("keeps a newspaper hit only when it overlaps the question's street, person, or topic", () => {
    const lake = "What did the board decide about the Lake Street streetscape, how much did it cost, who was the contractor, and were there any change orders?";
    expect(newsEvidenceIsRelevant(lake, "The Percy Julian streetscape is underway on Oak Park Avenue.")).toBe(false);
    expect(newsEvidenceIsRelevant(lake, "Another Oak Park Ave streetscape update.")).toBe(false);
    expect(newsEvidenceIsRelevant(lake, "The Lake Street streetscape contract changed.")).toBe(true);
    expect(newsEvidenceIsRelevant(lake, "Merchants on Lake St. asked for a schedule.")).toBe(true);
    const budget = "How has the village budget changed over the last three years?";
    expect(newsEvidenceIsRelevant(budget, "Wednesday Journal: the village drew on budget reserves to close the gap.")).toBe(true);
    expect(newsEvidenceIsRelevant(budget, "The Percy Julian streetscape opens Saturday.")).toBe(false);
    expect(newsEvidenceIsRelevant("Who is Robert Milstein?", "Wednesday Journal profile of Milstein.")).toBe(true);
    expect(newsEvidenceIsRelevant("Who is Robert Milstein?", "Bob was named Villager of the Year.")).toBe(true);
    expect(newsEvidenceIsRelevant("Who is Robert Milstein?", "https://www.oakpark.com/2003/12/31/villager-of-the-year/")).toBe(true);
    expect(newsEvidenceIsRelevant("Who is Robert Milstein?", "A page about water bills and parking permits.")).toBe(false);

    const reserves = item({
      id: "https://www.oakpark.com/reserves?utm_source=openai",
      kind: "newspaper",
      filename: "Wednesday Journal",
      url: "https://www.oakpark.com/reserves?utm_source=openai",
      text: "The village drew on budget reserves to close the gap.",
      score: 0.8,
    });
    const otherStreet = item({
      id: "https://www.oakpark.com/percy",
      kind: "newspaper",
      filename: "Wednesday Journal",
      url: "https://www.oakpark.com/percy",
      text: "The Percy Julian streetscape is underway on Oak Park Avenue.",
      score: 0.9,
    });
    const record = item({
      id: "file-budget",
      kind: "record",
      filename: "fy26-budget-book.pdf",
      text: "The FY2026 budget book compares spending.",
      score: 0.7,
    });
    const budgetEvidence = filterNewsEvidence(budget, [otherStreet, reserves, record]);
    expect(budgetEvidence.map((entry) => entry.id)).toEqual([
      "https://www.oakpark.com/reserves?utm_source=openai",
      "file-budget",
    ]);
    const budgetPrompt = formatEvidence(budgetEvidence, budget);
    expect(budgetPrompt).toContain("budget reserves");
    expect(budgetPrompt).toContain("https://www.oakpark.com/reserves");
    expect(budgetPrompt).not.toContain("utm_source");
    expect(budgetPrompt).toContain("Integrate each relevant newspaper finding into the answer prose");
    expect(budgetPrompt).toContain("budget figure or a reserve draw");
    expect(budgetPrompt).toContain("cite both");
    expect(budgetPrompt).not.toContain("Percy Julian");

    const lakeEvidence = filterNewsEvidence(lake, [otherStreet, item({
      id: "https://www.oakpark.com/lake",
      kind: "newspaper",
      filename: "Wednesday Journal",
      url: "https://www.oakpark.com/lake",
      text: "The Lake Street streetscape contract was awarded.",
      score: 0.8,
    })]);
    expect(lakeEvidence.map((entry) => entry.text)).toEqual(["The Lake Street streetscape contract was awarded."]);
  });

  it("requires a who-is answer to use newspaper results that name the person", () => {
    const question = "Who is Robert Milstein?";
    const kept = filterNewsEvidence(question, [
      item({
        id: "https://www.oakpark.com/market",
        kind: "newspaper",
        filename: "Wednesday Journal",
        url: "https://www.oakpark.com/market",
        text: "The farmers market opens on Saturday.",
        score: 0.4,
      }),
      item({
        id: "https://www.oakpark.com/milstein?utm_source=openai",
        kind: "newspaper",
        filename: "Wednesday Journal",
        title: "Robert Milstein",
        url: "https://www.oakpark.com/milstein?utm_source=openai",
        text: "A Wednesday Journal profile of Robert Milstein.",
        score: 0.8,
      }),
    ]);
    expect(kept).toHaveLength(1);
    const prompt = formatEvidence(kept, question);
    expect(prompt).toContain("You must use every newspaper result that mentions Robert Milstein ([1])");
    expect(prompt).toContain("https://www.oakpark.com/milstein");
    expect(prompt).not.toContain("utm_source");
    const aligned = alignCitations(
      "Robert Milstein served as a trustee. [1]\n\nThe Wednesday Journal reported: * list a specific pickup day. [2]\n\nThe Chicago Tribune reported:",
      kept,
    );
    expect(aligned.answer).toBe("Robert Milstein served as a trustee. [1]");
    expect(aligned.citations.map((citation) => citation.url)).toEqual(["https://www.oakpark.com/milstein"]);
  });
});
