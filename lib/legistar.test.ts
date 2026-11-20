import { describe, expect, it, vi } from "vitest";

import {
  describeLegistarMatter,
  legistarClientFor,
  legistarFileNumbers,
  legistarFilters,
  legistarKeywords,
  legistarSearchMatters,
  legistarVectorQuery,
  parseLegistarMatters,
  queryLegistarMatters,
  selectLegistarMatters,
  wantsLegistarLookup,
  type LegistarMatter,
} from "./legistar";

const NOW = new Date("2026-11-20T18:00:00.000Z");

function matter(partial: Partial<LegistarMatter> & Pick<LegistarMatter, "id" | "file" | "title" | "statusName">): LegistarMatter {
  return {
    guid: `GUID-${partial.id}`,
    typeName: partial.file.startsWith("MOT") ? "Motion" : partial.file.startsWith("RES") ? "Resolution" : "Ordinance",
    introDate: partial.passedDate,
    url: `https://oak-park.legistar.com/LegislationDetail.aspx?ID=${partial.id}&GUID=GUID-${partial.id}`,
    ...partial,
  };
}

const OVERNIGHT = "What are the current overnight parking rules?";

const FIXTURES: LegistarMatter[] = [
  matter({
    id: 8520,
    file: "MOT 24-142",
    statusName: "Passed",
    passedDate: "2024-04-11",
    introDate: "2024-03-18",
    title: "A Motion to Concur with the Transportation Commission's Recommendation to Expand Street Frontage Locations for Overnight On-Street Permit Parking in Zones Y1 and Y2",
  }),
  matter({
    id: 8312,
    file: "ORD 23-118",
    statusName: "Passed",
    passedDate: "2023-12-04",
    introDate: "2023-11-21",
    title: "Second Reading and Adoption of an Ordinance Amending Chapter 15, Section 15-3-18 of the Oak Park Village Code to Expand Eligibility Criteria for the Reduced Parking Permit Fee Program",
  }),
  matter({
    id: 8254,
    file: "ORD 23-112",
    statusName: "First Reading",
    introDate: "2023-11-06",
    title: "First Reading of an Ordinance Amending Chapter 15, Section 15-3-18 of the Oak Park Village Code to Expand Eligibility Criteria for the Reduced Parking Permit Fee Program",
  }),
  matter({
    id: 9901,
    file: "MOT 26-189",
    statusName: "Passed",
    passedDate: "2026-08-25",
    title: "A Motion to Concur with the Transportation Commission's Recommendation to Expand Overnight Permit Parking Zone Z1 Adjacent to 6104 Roosevelt Road",
  }),
  matter({
    id: 9700,
    file: "ORD 26-108",
    statusName: "Passed",
    passedDate: "2026-01-27",
    title: "An Ordinance Amending Section 15-3-18 of the Oak Park Village Code to Extend the Free Parking Time at the Village's Avenue Garage",
  }),
  matter({
    id: 8800,
    file: "RES 24-370",
    statusName: "Passed",
    passedDate: "2024-12-03",
    title: "A Resolution Approving a Renewal of an Independent Contractor Agreement with A & B Landscaping for Snow Plowing of Village Parking Lots",
  }),
  matter({
    id: 8600,
    file: "RES 24-342",
    statusName: "Passed",
    passedDate: "2024-12-03",
    title: "A Resolution Approving a Funding Grant Agreement to Fund Emergency Overnight Shelter for Persons Experiencing Homelessness",
  }),
  matter({
    id: 10350,
    file: "RES 26-314",
    statusName: "Passed",
    passedDate: "2026-11-04",
    title: "A Resolution Approving an Amendment to the Professional Services Agreement with Securitas to Provide Additional Overnight Security at the Parking Structure",
  }),
];

describe("Legistar lookup", () => {
  it("builds keyword and file-number filters for a legislative question", () => {
    expect(legistarClientFor("oak-park-il")).toBe("oak-park");
    expect(legistarClientFor("strawberry-point-ia")).toBeNull();
    expect(wantsLegistarLookup("[TEST] What are the current overnight parking rules?")).toBe(true);
    expect(wantsLegistarLookup("Who was the Lake Street streetscape construction contractor?")).toBe(false);
    expect(wantsLegistarLookup("What did the board adopt for the budget?")).toBe(true);
    expect(wantsLegistarLookup("What did the village do in April 2024 about overnight parking?")).toBe(true);
    expect(wantsLegistarLookup("Did they approve the overnight parking expansion?")).toBe(true);
    expect(wantsLegistarLookup("How has the village budget changed over the last three years?")).toBe(false);
    const april = legistarFilters("What did the village do in April 2024 about overnight parking?", NOW);
    expect(april.some((filter) => filter.includes("substringof('overnight',MatterTitle)"))).toBe(true);
    expect(april.some((filter) => filter.includes("datetime'2024-01-01'"))).toBe(true);
    expect(legistarKeywords(OVERNIGHT)).toEqual(["overnight", "parking"]);
    expect(legistarFileNumbers("See Ord. 23-118 and MOT 24-142 and Ordinance 23-118.")).toEqual(["ORD 23-118", "MOT 24-142"]);
    const filters = legistarFilters(OVERNIGHT, NOW);
    expect(filters.some((filter) => filter.includes("substringof('overnight',MatterTitle)"))).toBe(true);
    expect(filters.some((filter) => filter.includes("substringof('parking',MatterTitle)"))).toBe(true);
    expect(filters.some((filter) => filter.includes("datetime'2023-11-20'"))).toBe(true);
    expect(legistarFilters("What is the status of ORD 23-118?", NOW).some((filter) => filter.includes("MatterFile eq 'ORD 23-118'"))).toBe(true);
    expect(legistarFilters("How has the village budget changed?", NOW)).toEqual([]);
  });

  it("keeps the adopted overnight motion and the passed fee ordinance, and drops contracts", () => {
    const selected = selectLegistarMatters(OVERNIGHT, FIXTURES);
    const files = selected.map((entry) => entry.file);
    expect(files).toContain("MOT 24-142");
    expect(files).toContain("ORD 23-118");
    expect(files).toContain("ORD 23-112");
    expect(files).not.toContain("RES 24-370");
    expect(files).not.toContain("RES 24-342");
    expect(files).not.toContain("RES 26-314");
    const search = legistarSearchMatters(OVERNIGHT, selected).map((entry) => entry.file);
    expect(search).toContain("MOT 24-142");
    expect(search).toContain("ORD 23-118");
    expect(legistarVectorQuery(selected.find((entry) => entry.file === "ORD 23-118")!)).toContain("Reduced Parking Permit Fee Program");
    expect(legistarVectorQuery(selected.find((entry) => entry.file === "ORD 23-118")!)).toContain("ORD 23-118");

    const adopted = describeLegistarMatter(selected.find((entry) => entry.file === "ORD 23-118")!);
    expect(adopted).toContain("Status Passed");
    expect(adopted).toContain("adopted this ordinance on 2023-12-04");
    expect(adopted).toContain("Do not describe it as only a proposal.");
    expect(adopted).toContain("https://oak-park.legistar.com/LegislationDetail.aspx?ID=8312");
    const proposal = describeLegistarMatter(selected.find((entry) => entry.file === "ORD 23-112")!);
    expect(proposal).toContain("not an adoption");
  });

  it("parses a matter payload and keeps going when one request fails", async () => {
    const payload = [{
      MatterId: 8312,
      MatterGuid: "FD6FA2C2-C72A-40D1-B25C-04C1A833848F",
      MatterFile: "ORD 23-118",
      MatterTitle: "Second Reading and Adoption of an Ordinance Amending the Reduced Parking Permit Fee Program",
      MatterTypeName: "Ordinance",
      MatterStatusName: "Passed",
      MatterIntroDate: "2023-11-21T00:00:00",
      MatterPassedDate: "2023-12-04T00:00:00",
      MatterBodyName: "President and Board of Trustees",
    }];
    const parsed = parseLegistarMatters(payload, "oak-park");
    expect(parsed[0]?.url).toBe("https://oak-park.legistar.com/LegislationDetail.aspx?ID=8312&GUID=FD6FA2C2-C72A-40D1-B25C-04C1A833848F");
    expect(parsed[0]?.passedDate).toBe("2023-12-04");
    expect(parseLegistarMatters({ message: "nope" }, "oak-park")).toEqual([]);

    const fetchImpl = vi.fn(async (url: string) => {
      const filter = new URL(String(url)).searchParams.get("$filter") ?? "";
      if (filter.includes("MatterFile")) return Response.json(payload);
      if (filter.includes("overnight")) return Response.json([], { status: 500 });
      return Response.json([{
        MatterId: 8520,
        MatterGuid: "D6F507E1-FCC1-476B-9F65-CC50D7408515",
        MatterFile: "MOT 24-142",
        MatterTitle: "Expand Overnight On-Street Permit Parking in Zones Y1 and Y2",
        MatterTypeName: "Motion",
        MatterStatusName: "Passed",
        MatterIntroDate: "2024-03-18T00:00:00",
        MatterPassedDate: "2024-04-11T00:00:00",
      }]);
    });
    const matters = await queryLegistarMatters({
      clientName: "oak-park",
      question: OVERNIGHT,
      now: NOW,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalled();
    expect(matters.map((entry) => entry.file)).toEqual(expect.arrayContaining(["MOT 24-142"]));
    const pinned = await queryLegistarMatters({
      clientName: "oak-park",
      question: OVERNIGHT,
      now: NOW,
      onlyFiles: ["ORD 23-118"],
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(pinned.map((entry) => entry.file)).toEqual(["ORD 23-118"]);
    await expect(queryLegistarMatters({
      clientName: "oak-park",
      question: OVERNIGHT,
      now: NOW,
      fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch,
    })).resolves.toEqual([]);
  });
});
