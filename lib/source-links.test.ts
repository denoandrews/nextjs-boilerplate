import { describe, expect, it } from "vitest";
import {
  allowedAnswerUrl,
  citationUrlForFile,
  officialPages,
  safeHttpsUrl,
  withStoredSourceUrls,
} from "./source-links";

describe("official source links", () => {
  it("publishes distinct https pages for Oak Park only", () => {
    const pages = officialPages("oak-park-il");
    expect(pages.length).toBeGreaterThan(0);
    expect(new Set(pages.map((page) => page.url)).size).toBe(pages.length);
    for (const page of pages) expect(safeHttpsUrl(page.url)).toBe(page.url);
    expect(officialPages("strawberry-point-ia")).toEqual([]);
  });

  it("rejects unsafe urls and lookalike hosts", () => {
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("http://www.oak-park.us/a")).toBeNull();
    expect(safeHttpsUrl("https://user:secret@www.oak-park.us/a")).toBeNull();
    expect(allowedAnswerUrl("https://oak-park.us.evil.test/a", "oak-park-il")).toBeNull();
    expect(allowedAnswerUrl("https://www.oak-park.us/Government/Leadership/Village-Board", "oak-park-il")).toBeTruthy();
    expect(allowedAnswerUrl("https://www.oak-park.us/a", "strawberry-point-ia")).toBeNull();
  });

  it("prefers a stored document url over a filename guess", () => {
    const citations = withStoredSourceUrls(
      [{ fileId: "file-1", filename: "fence-guidelines.pdf", url: "https://example.test/guess" }],
      new Map([["file-1", "https://www.oak-park.us/fence.pdf"]])
    );
    expect(citations[0].url).toBe("https://www.oak-park.us/fence.pdf");
    expect(citationUrlForFile({ slug: "oak-park-il", filename: "notes.pdf", attributeUrl: "javascript:alert(1)" })).toBeNull();
    expect(citationUrlForFile({
      slug: "oak-park-il",
      filename: "packet https://www.oak-park.us/files/agenda.pdf",
    })).toBe("https://www.oak-park.us/files/agenda.pdf");
  });
});
