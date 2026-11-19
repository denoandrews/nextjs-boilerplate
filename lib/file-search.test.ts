import { describe, expect, it } from "vitest";

import { dateBoostFor, fileSearchFilters, formatAttributeIndex, questionAsksAboutHistory, shiftMonths } from "./file-search";

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

const NOW = new Date("2026-11-19T18:00:00.000Z");

describe("date weighting", () => {
  it("boosts the last 18 and 36 months, leaves undated files alone, and skips history", () => {
    expect(shiftMonths(20261119, 18)).toBe(20250519);
    expect(shiftMonths(20261119, 36)).toBe(20231119);
    expect(dateBoostFor(20261013, 20261119, false)).toBe(1.3);
    expect(dateBoostFor(20240618, 20261119, false)).toBe(1.15);
    expect(dateBoostFor(20210222, 20261119, false)).toBe(1);
    expect(dateBoostFor(undefined, 20261119, false)).toBe(1);
    expect(dateBoostFor(20261013, 20261119, true)).toBe(1);
    expect(questionAsksAboutHistory("What is the history of the Roosevelt Road TIF?")).toBe(true);
    expect(questionAsksAboutHistory("What is the current overnight parking policy?")).toBe(false);
  });

  it("ranks a recent parking change above a close older ordinance and does not sink an undated file", () => {
    const index = formatAttributeIndex(
      [
        { fileId: "y2021", filename: "2021-overnight-ordinance.pdf", score: 0.86, recordDate: 20210222, documentType: "ordinance" },
        { fileId: "y2024", filename: "2024-06-18-overnight-ordinance.pdf", score: 0.78, recordDate: 20240618, documentType: "ordinance" },
        { fileId: "undated", filename: "parking-roster.pdf", score: 0.9, documentType: "policy" },
      ],
      { question: "What is the current overnight parking policy?", now: NOW },
    );
    const recent = index!.indexOf("2024-06-18-overnight-ordinance.pdf");
    const older = index!.indexOf("2021-overnight-ordinance.pdf");
    const undated = index!.indexOf("parking-roster.pdf");
    expect(undated).toBeGreaterThan(-1);
    expect(undated).toBeLessThan(recent);
    expect(recent).toBeLessThan(older);
  });

  it("does not boost recent files when the question asks about history", () => {
    const hits = [
      { fileId: "old", filename: "2014-tif-study.pdf", score: 0.9, recordDate: 20140101, documentType: "study" },
      { fileId: "new", filename: "2026-tif-note.pdf", score: 0.8, recordDate: 20261001, documentType: "minutes" },
    ];
    const history = formatAttributeIndex(hits, { question: "What is the history of the Roosevelt Road TIF?", now: NOW });
    expect(history!.indexOf("2014-tif-study.pdf")).toBeLessThan(history!.indexOf("2026-tif-note.pdf"));
    const current = formatAttributeIndex(hits, { question: "What is the current status of the Roosevelt Road TIF?", now: NOW });
    expect(current!.indexOf("2026-tif-note.pdf")).toBeLessThan(current!.indexOf("2014-tif-study.pdf"));
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
    ], { question: "What did the minutes say?", now: NOW });

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
