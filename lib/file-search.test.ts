import { describe, expect, it } from "vitest";

import { fileSearchFilters, formatAttributeIndex } from "./file-search";

describe("file search filters", () => {
  it("filters Oak Park minutes, agendas, and budgets by document_type", () => {
    expect(fileSearchFilters("What did the latest minutes say?", "oak-park-il")).toEqual({
      type: "eq",
      key: "document_type",
      value: "minutes",
    });
    expect(fileSearchFilters("What's on the agenda?", "oak-park-il")).toEqual({
      type: "eq",
      key: "document_type",
      value: "agenda",
    });
    expect(fileSearchFilters("What is the FY2026 budget?", "oak-park-il")).toEqual({
      type: "eq",
      key: "document_type",
      value: "budget",
    });
    expect(fileSearchFilters("What did the minutes say about the budget?", "oak-park-il")).toEqual({
      type: "in",
      key: "document_type",
      value: ["minutes", "budget"],
    });
  });

  it("treats a next meeting as minutes and agendas, including in Spanish", () => {
    expect(fileSearchFilters("When is the next board meeting?", "oak-park-il")).toEqual({
      type: "in",
      key: "document_type",
      value: ["minutes", "agenda"],
    });
    expect(fileSearchFilters("¿Cuándo es la próxima reunión?", "oak-park-il")).toEqual({
      type: "in",
      key: "document_type",
      value: ["minutes", "agenda"],
    });
    expect(fileSearchFilters("¿Cuál es el presupuesto?", "oak-park-il")).toEqual({
      type: "eq",
      key: "document_type",
      value: "budget",
    });
  });

  it("does not filter on record_date, even when the question asks for recent records", () => {
    const filter = fileSearchFilters("Show the most recent minutes since 2024", "oak-park-il");
    expect(filter).toEqual({ type: "eq", key: "document_type", value: "minutes" });
    expect(JSON.stringify(filter)).not.toContain("record_date");
  });

  it("stays unfiltered when a filter would hide the better source or files without attributes", () => {
    expect(fileSearchFilters("What does the fence ordinance allow?", "oak-park-il")).toBeUndefined();
    expect(fileSearchFilters("What is the history of the budget?", "oak-park-il")).toBeUndefined();
    expect(fileSearchFilters("How many times do the minutes record a 6-1 vote?", "oak-park-il")).toBeUndefined();
    expect(fileSearchFilters("How do I pay a parking ticket?", "oak-park-il")).toBeUndefined();
    expect(fileSearchFilters("Show me the latest minutes", "strawberry-point-ia")).toBeUndefined();
  });
});

describe("attribute index", () => {
  it("shows title and record_date, newest first, and keeps files with no date", () => {
    const index = formatAttributeIndex([
      {
        fileId: "file-old",
        filename: "2017-minutes.pdf",
        title: "Old minutes",
        recordDate: 20170918,
        documentType: "minutes",
      },
      {
        fileId: "file-old",
        filename: "2017-minutes.pdf",
        title: "Old minutes duplicate",
        recordDate: 20170918,
        documentType: "minutes",
      },
      {
        fileId: "file-new",
        filename: "2026-10-13-minutes.pdf",
        title: "October 13 minutes",
        recordDate: 20261013,
        documentType: "minutes",
        status: "current",
      },
      {
        fileId: "file-undated",
        filename: "packet.pdf",
        title: "Packet",
        documentType: "minutes",
      },
    ]);

    expect(index).toContain("title:");
    expect(index).toContain("record_date");
    expect(index).toContain("20261013 is October 13, 2026");
    const newer = index!.indexOf("2026-10-13-minutes.pdf");
    const older = index!.indexOf("2017-minutes.pdf");
    const undated = index!.indexOf("record_date: none");
    expect(newer).toBeGreaterThan(-1);
    expect(newer).toBeLessThan(older);
    expect(older).toBeLessThan(undated);
    expect(index).toContain("title: October 13 minutes");
    expect(index).toContain("status: current");
    expect(index).not.toContain("Old minutes duplicate");
    expect(index!.match(/filename:/g)).toHaveLength(3);
  });

  it("returns nothing when there are no hits", () => {
    expect(formatAttributeIndex([])).toBeNull();
  });
});
