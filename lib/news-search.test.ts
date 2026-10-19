import { describe, expect, it } from "vitest";
import { answerSegments, approvedNewspaperUrl, cleanCitedText, closeTruncatedAnswer, extractCitedAnswer, newspaperDomains, splitNewsReferences } from "./news-search";

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
  it("removes citation markers without leaving a space before punctuation", () => {
    const marked = "The title is 'Village President' \uE200cite\uE202turn0file1\uE201.";
    expect(cleanCitedText(marked)).toBe("The title is 'Village President'.");
    expect(cleanCitedText("the \uE200filecite\uE202x\uE201 ordinance")).toBe("the ordinance");
  });
  it("links a file from metadata, then from a known filename", () => {
    const withAttribute = extractCitedAnswer({
      output: [
        { type: "file_search_call", results: [{ file_id: "file-1", filename: "fence-guidelines-2025-08.pdf", attributes: { source_url: "https://cdn.example.gov/fence.pdf" } }] },
        { type: "message", content: [{ type: "output_text", text: "A permit is required.", annotations: [{ type: "file_citation", file_id: "file-1", filename: "fence-guidelines-2025-08.pdf" }] }] },
      ],
    } as never, false, { slug: "oak-park-il" });
    expect(withAttribute.citations[0].url).toBe("https://cdn.example.gov/fence.pdf");

    const fromName = extractCitedAnswer(response("See the guidelines.", [{ type: "file_citation", file_id: "file-2", filename: "fence-guidelines-2025-08.pdf" }]), false, { slug: "oak-park-il" });
    expect(fromName.citations[0].url).toContain("fence-guidelines-2025-08.pdf");
    const otherTown = extractCitedAnswer(response("See the guidelines.", [{ type: "file_citation", file_id: "file-2", filename: "fence-guidelines-2025-08.pdf" }]), false, { slug: "strawberry-point-ia" });
    expect(otherTown.citations[0].url).toBeUndefined();
  });
  it("closes an answer that hit the output-token limit", () => {
    const result = extractCitedAnswer({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "message", content: [{ type: "output_text", text: "Place carts out by 7 a.m. The rest keeps going", annotations: [] }] }],
    } as never, false);
    expect(result.answer).toBe("Place carts out by 7 a.m.\n\nThe rest of this answer was cut off. Ask a follow-up if you need more.");
    expect(closeTruncatedAnswer("La ordenanza evita el escurrimiento", true)).toContain("se cortó");
  });
  it("linkifies an official page and leaves other towns' text alone", () => {
    const linked = answerSegments("Agendas: https://www.oak-park.us/Government/Meetings/Village-Board-Agendas-Minutes-Videos.", [], "oak-park-il");
    expect(linked.filter((part) => part.href)).toHaveLength(1);
    expect(linked.at(-1)?.text).toBe(".");
    expect(answerSegments("https://www.oak-park.us/Government/Leadership/Village-Board", [], "strawberry-point-ia").every((part) => !part.href)).toBe(true);
  });
});
