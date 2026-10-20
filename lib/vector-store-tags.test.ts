import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readScanCache, writeScanCache } from "./vector-store-tag-cache";
import {
  attributesForRow,
  classifyDocumentType,
  decodeFileContent,
  finalizeProposals,
  parseContentDate,
  parseFilenameDate,
  parseTagsCsv,
  proposeTag,
  tagsToCsv,
} from "./vector-store-tags";

describe("filename dates", () => {
  it("reads a leading YYYY-MM-DD before any date in the text", () => {
    const parsed = parseFilenameDate("2020-05-18_VillageBoard__24_2_-Remedial_Action_Plan.pdf");
    expect(parsed.recordDate).toBe(20200518);
    expect(parsed.confidence).toBe("high");

    const proposal = proposeTag({
      fileId: "file-rap",
      filename: "2020-05-18_VillageBoard__24_2_-Remedial_Action_Plan.pdf",
      city: "oak-park-il",
      text: "Meeting Date: January 2, 1999",
    });
    expect(proposal.record_date).toBe("20200518");
    expect(proposal.date_source).toBe("filename");
    expect(proposal.document_type).toBe("study");
    expect(proposal.needs_review).toBe("no");
    expect(proposal.status).toBe("");
    expect(proposal.source_url).toBe("");
  });

  it("reads a minutes filename date and does not invent a meetings-page URL", () => {
    const proposal = proposeTag({
      fileId: "file-minutes",
      filename: "Minutes - 2025-05-06 Village Board.pdf",
      city: "oak-park-il",
    });
    expect(proposal.record_date).toBe("20250506");
    expect(proposal.document_type).toBe("minutes");
    expect(proposal.date_source).toBe("filename");
    expect(proposal.confidence).toBe("high");
    expect(proposal.source_url).toBe("");
  });

  it("uses the later date when a filename says revised", () => {
    const parsed = parseFilenameDate("2017-09-18-zoning-ordinance-revised-2026-04-03.pdf");
    expect(parsed.recordDate).toBe(20260403);
    expect(parsed.confidence).toBe("high");
  });

  it("flags two filename dates that are not a revision", () => {
    const proposal = proposeTag({
      fileId: "file-two",
      filename: "2015-01-04_and_2016-02-05_minutes.pdf",
      city: "oak-park-il",
    });
    expect(proposal.date_source).toBe("filename");
    expect(proposal.record_date).toBe("20150104");
    expect(proposal.confidence).toBe("low");
    expect(proposal.needs_review).toBe("yes");
  });

  it("ignores an impossible filename date and does not treat YYYY-MM as a day", () => {
    expect(parseFilenameDate("2020-02-31_minutes.pdf").recordDate).toBeNull();
    expect(parseFilenameDate("fence-guidelines-2025-08.pdf").recordDate).toBeNull();
  });
});

describe("content dates", () => {
  it("prefers a labeled meeting or adoption date", () => {
    const parsed = parseContentDate(`
      Village of Oak Park
      Village Board Meeting
      Meeting Date: May 6, 2025
      The packet also mentions a hearing in 2015.
    `);
    expect(parsed.recordDate).toBe(20250506);
    expect(parsed.confidence).toBe("high");

    const adopted = parseContentDate("ADOPTED: April 3, 2026\nThis text follows the adoption line.");
    expect(adopted.recordDate).toBe(20260403);
    expect(adopted.confidence).toBe("high");
  });

  it("flags a single unlabeled date near the top", () => {
    const parsed = parseContentDate("Village Board\nMonday, October 13, 2026\nCall to order.");
    expect(parsed.recordDate).toBe(20261013);
    expect(parsed.confidence).toBe("medium");
  });

  it("flags several unlabeled dates and keeps the first", () => {
    const parsed = parseContentDate("The board met on March 3, 2016. A prior hearing was January 4, 2015.");
    expect(parsed.recordDate).toBe(20160303);
    expect(parsed.confidence).toBe("low");
    expect(parsed.notes).toMatch(/Several dates/);
  });

  it("flags disagreeing labeled dates", () => {
    const parsed = parseContentDate("Adopted on April 3, 2026. Originally adopted on September 18, 2017.");
    expect(parsed.recordDate).toBe(20260403);
    expect(parsed.confidence).toBe("low");
  });

  it("returns none when the opening text has no full date", () => {
    const parsed = parseContentDate("A memo about backyard chickens. No calendar day is printed here.");
    expect(parsed.recordDate).toBeNull();
    const proposal = proposeTag({
      fileId: "file-none",
      filename: "backyard-chickens.pdf",
      city: "oak-park-il",
      text: "A memo about backyard chickens. No calendar day is printed here.",
    });
    expect(proposal.date_source).toBe("none");
    expect(proposal.record_date).toBe("");
    expect(proposal.needs_review).toBe("yes");
  });

  it("uses content only when the filename has no YYYY-MM-DD", () => {
    const proposal = proposeTag({
      fileId: "file-packet",
      filename: "Village Board Minutes.pdf",
      city: "oak-park-il",
      text: "Village Board\nMeeting Date: October 13, 2026\n",
      contentNote: "Date text read from the vector store content endpoint.",
    });
    expect(proposal.date_source).toBe("content");
    expect(proposal.record_date).toBe("20261013");
    expect(proposal.document_type).toBe("minutes");
    expect(proposal.confidence).toBe("high");
    expect(proposal.needs_review).toBe("no");
    expect(proposal.notes).toMatch(/vector store content/);
  });
});

describe("document types", () => {
  it("classifies proposals, studies, and staff reports from the name", () => {
    expect(classifyDocumentType("2020-05-18_VillageBoard__24_2_-TPI_Proposal.pdf", "").documentType).toBe("proposal");
    expect(classifyDocumentType("2018 Parking Services RFP.pdf", "").documentType).toBe("proposal");
    expect(classifyDocumentType("Waste Hauler Bid.pdf", "").documentType).toBe("proposal");
    expect(classifyDocumentType("Fence Quote.pdf", "").documentType).toBe("proposal");
    expect(classifyDocumentType("Request for Quotation.pdf", "").documentType).toBe("proposal");
    expect(classifyDocumentType("2015-04-06_VillageBoard_Study_Session_Noise.pdf", "").documentType).toBe("study");
    expect(classifyDocumentType("Traffic Analysis.pdf", "").documentType).toBe("study");
    expect(classifyDocumentType("Downtown Plan Study.pdf", "").documentType).toBe("study");
    expect(classifyDocumentType("2020-05-18_VillageBoard__24_2_-Remedial_Action_Plan.pdf", "").documentType).toBe("study");
    expect(classifyDocumentType("2016-11-07_VillageBoard_Managers_Report_Chickens.pdf", "").documentType).toBe("staff_report");
    expect(classifyDocumentType("Manager's Report.pdf", "").documentType).toBe("staff_report");
    expect(classifyDocumentType("fy26-budget-book-final.pdf", "").documentType).toBe("budget");
    expect(classifyDocumentType("fence-guidelines-2025-08.pdf", "").documentType).toBe("policy");
    expect(classifyDocumentType("zoning-ordinance-revised.pdf", "").documentType).toBe("ordinance");
  });

  it("lets a proposal word beat a surrounding minutes word", () => {
    expect(classifyDocumentType("Minutes covering the parking RFP.pdf", "").documentType).toBe("proposal");
  });
});

describe("status and review", () => {
  it("leaves status blank unless the name says draft or superseded", () => {
    const minutes = proposeTag({ fileId: "file-m", filename: "Minutes - 2024-01-02.pdf", city: "oak-park-il" });
    expect(minutes.status).toBe("");
    const draft = proposeTag({ fileId: "file-d", filename: "2022-01-01_zoning_ordinance_draft.pdf", city: "oak-park-il" });
    expect(draft.status).toBe("draft");
    expect(draft.document_type).toBe("ordinance");
  });

  it("marks an older budget superseded only when a newer budget is present", () => {
    const rows = finalizeProposals([
      proposeTag({ fileId: "file-old", filename: "fy24-budget-book.pdf", city: "oak-park-il", text: "Adopted on January 1, 2024." }),
      proposeTag({ fileId: "file-new", filename: "fy26-budget-book-final.pdf", city: "oak-park-il", text: "Adopted on January 1, 2026." }),
    ]);
    expect(rows[0].status).toBe("superseded");
    expect(rows[1].status).toBe("current");
    expect(rows[1].source_url).toContain("fy26-budget-book-final.pdf");
    const alone = finalizeProposals([
      proposeTag({ fileId: "file-only", filename: "fy23-budget-book.pdf", city: "oak-park-il", text: "Adopted on January 1, 2023." }),
    ]);
    expect(alone[0].status).toBe("");
  });

  it("fills source_url from a stored https URL", () => {
    const proposal = proposeTag({
      fileId: "file-url",
      filename: "Minutes - 2025-05-06.pdf",
      city: "oak-park-il",
      externalUrl: "https://www.oak-park.us/files/minutes.pdf",
    });
    expect(proposal.source_url).toBe("https://www.oak-park.us/files/minutes.pdf");
    expect(proposal.needs_review).toBe("no");
  });
});

describe("CSV apply rules", () => {
  it("round-trips proposed columns and skips rows that still need review", () => {
    const proposal = proposeTag({
      fileId: "file-minutes",
      filename: "Minutes - 2025-05-06 Village Board.pdf",
      city: "oak-park-il",
    });
    const reviewed = { ...proposal, title: "Minutes, \"May 6\"" };
    const parsed = parseTagsCsv(tagsToCsv([proposal, reviewed]));
    expect(parsed[1].title).toBe("Minutes, \"May 6\"");
    const decision = attributesForRow(parsed[0]);
    expect(decision).toMatchObject({
      action: "apply",
      attributes: {
        city: "oak-park-il",
        document_type: "minutes",
        record_date: 20250506,
        title: proposal.title,
      },
    });
    if (decision.action === "apply") expect(decision.attributes).not.toHaveProperty("status");

    const uncertain = { ...proposal, needs_review: "yes" as const, confidence: "low" as const };
    expect(attributesForRow(uncertain)).toEqual({ action: "skip", reason: "needs_review" });
    expect(attributesForRow({ ...uncertain, needs_review: "no", document_type: "" })).toMatchObject({
      action: "skip",
      reason: expect.stringMatching(/document_type/),
    });
  });

  it("applies a reviewed row after the reviewer clears needs_review and fills the type", () => {
    const decision = attributesForRow({
      file_id: "file-chickens",
      filename: "chickens.pdf",
      city: "oak-park-il",
      source_url: "",
      record_date: "20161107",
      document_type: "staff_report",
      status: "",
      title: "Manager report on chickens",
      date_source: "content",
      confidence: "low",
      needs_review: "no",
      notes: "Reviewer filled the type and date.",
    });
    expect(decision).toEqual({
      action: "apply",
      attributes: {
        city: "oak-park-il",
        document_type: "staff_report",
        title: "Manager report on chickens",
        record_date: 20161107,
      },
    });
  });
});

describe("file content decoding and cache", () => {
  it("separates text from PDF bytes", () => {
    expect(decodeFileContent(new TextEncoder().encode("%PDF-1.7\n"), "application/octet-stream").kind).toBe("pdf");
    const text = decodeFileContent(new TextEncoder().encode("Meeting Date: May 6, 2025"), "application/octet-stream");
    expect(text).toMatchObject({ kind: "text" });
  });

  it("resumes from a scan cache without rewriting the filename", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vector-tags-"));
    await writeScanCache(directory, "vs_oak", "file-1", {
      filename: "Minutes - 2025-05-06.pdf",
      text: null,
      contentMethod: "none",
      fetchedContent: false,
    });
    const cached = await readScanCache(directory, "vs_oak", "file-1");
    expect(cached?.filename).toBe("Minutes - 2025-05-06.pdf");
    expect(cached?.fetchedContent).toBe(false);
    await expect(readFile(path.join(directory, "vs_oak", "file-1.json"), "utf8")).resolves.toContain("Minutes");
  });
});

describe("tagging script safety", () => {
  it("updates attributes only and does not upload or delete", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/tag-vector-store.ts"), "utf8");
    expect(source).toMatch(/vectorStores\.files\.update\s*\(/);
    expect(source).not.toMatch(/uploadAndPoll|\.upload\s*\(|files\.create|vectorStores\.files\.delete|openai\.files\.delete/);
    expect(source).toMatch(/if \(values\.apply\)/);
    expect(source).toMatch(/new OpenAI\(\{ apiKey, timeout: timeoutMs, maxRetries: 2 \}\)/);
    expect(source).toMatch(/attempts: 3/);
  });
});
