import { describe, expect, it } from "vitest";
import { approvedNewspaperUrl, extractCitedAnswer, newspaperDomains, splitNewsReferences } from "./news-search";

function response(text: string, annotations: unknown[]) {
  return { output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text, annotations }] }] } as never;
}

describe("Oak Park newspaper search", () => {
  it("enables only the Oak Park tenant's two approved newspapers", () => {
    expect(newspaperDomains("oak-park-il")).toEqual(["oakpark.com", "chicagotribune.com"]);
    expect(newspaperDomains("strawberry-point-ia")).toEqual([]);
    expect(newspaperDomains("default")).toEqual([]);
  });
  it("rejects unsafe links and lookalike newspaper domains", () => {
    for (const url of ["javascript:alert(1)", "https://oakpark.com.evil.test/a", "https://evil.test/oakpark.com", "http://oakpark.com/a", "https://user:secret@oakpark.com/a"]) {
      expect(approvedNewspaperUrl(url)).toBeNull();
    }
    expect(approvedNewspaperUrl("https://www.oakpark.com/news/")).toBe("https://www.oakpark.com/news/");
    expect(approvedNewspaperUrl("https://www.chicagotribune.com/story/")).toBeTruthy();
  });
  it("deduplicates news citations, preserves files, and builds linked inline references", () => {
    const annotation = { type: "url_citation", url: "https://www.oakpark.com/a/", title: "An article", start_index: 6, end_index: 11 };
    const result = extractCitedAnswer(response("Claim CITE1 and CITE2", [annotation, { ...annotation, start_index: 16, end_index: 21 }, { type: "file_citation", file_id: "file-1", filename: "minutes.pdf" }]), true);
    expect(result.answer).toBe("Claim [News 1] and [News 1]");
    expect(result.citations).toHaveLength(2);
    expect(result.newsSearched).toBe(true);
    expect(splitNewsReferences(result.answer, result.citations).filter((part) => part.citation)).toHaveLength(2);
  });
  it("does not expose news citations to other tenants or link fabricated markers", () => {
    const result = extractCitedAnswer(response("Claim", [{ type: "url_citation", url: "https://oakpark.com/a", title: "Article", start_index: 0, end_index: 5 }]), false);
    expect(result.citations).toEqual([]);
    expect(result.newsSearched).toBe(false);
    expect(splitNewsReferences("Text [News 99]", []).every((part) => !part.citation)).toBe(true);
  });
  it("ignores malformed citation ranges without truncating the answer", () => {
    const result = extractCitedAnswer(response("Whole answer", [{ type: "url_citation", url: "https://oakpark.com/a", title: "Article", start_index: -1, end_index: 999 }]), true);
    expect(result.answer).toBe("Whole answer");
  });
});
