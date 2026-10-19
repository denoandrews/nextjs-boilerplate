import { describe, expect, it } from "vitest";
import { answerSegments, approvedNewspaperUrl, cleanCitedText, closeTruncatedAnswer, externalLinkProps, extractCitedAnswer, newspaperDomains, restorePeriodsAtFileCitations, splitNewsReferences } from "./news-search";

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
  it("keeps a period when a citation marker sits immediately before it", () => {
    const marked = "The title is 'Village President' \uE200cite\uE202turn0file1\uE201.";
    expect(cleanCitedText(marked)).toBe("The title is 'Village President'.");
    expect(cleanCitedText("the \uE200filecite\uE202x\uE201 ordinance")).toBe("the ordinance");
  });
  it("keeps a period that a marker swallowed at the end of a paragraph", () => {
    const marked = "Place carts out by 7:00 a.m. on that day \uE200cite\uE202turn0file0.\uE201\n\nThe next pickup is Thursday.";
    expect(cleanCitedText(marked)).toBe("Place carts out by 7:00 a.m. on that day.\n\nThe next pickup is Thursday.");
  });
  it("puts a period back when a citation marker ends a paragraph before the break", () => {
    const marked = "Place carts out by 7:00 a.m. on that day \uE200filecite\uE202turn0file2\uE202turn0file6\uE201\n\nBuildings of five or fewer units are collected once a week.";
    expect(cleanCitedText(marked)).toBe("Place carts out by 7:00 a.m. on that day.\n\nBuildings of five or fewer units are collected once a week.");
    expect(cleanCitedText("the \uE200cite\uE202turn0file1\uE201 ordinance requires a permit.")).toBe("the ordinance requires a permit.");
  });
  it("restores a period from a file_citation index at a paragraph break", () => {
    const text = "Place carts out by 7:00 a.m. on that day\n\nThe final sentence has its period.";
    const index = text.indexOf("\n\n");
    expect(restorePeriodsAtFileCitations(text, [index, index])).toBe("Place carts out by 7:00 a.m. on that day.\n\nThe final sentence has its period.");
    expect(restorePeriodsAtFileCitations("the ordinance requires a permit.", [4])).toBe("the ordinance requires a permit.");
    const extracted = extractCitedAnswer({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text,
          annotations: [{ type: "file_citation", file_id: "file-1", filename: "Garbage Collection.pdf", index }],
        }],
      }],
    } as never, false);
    expect(extracted.answer).toBe("Place carts out by 7:00 a.m. on that day.\n\nThe final sentence has its period.");
  });
  it("keeps a period that a marker swallowed at the end of an answer", () => {
    expect(cleanCitedText("Final sentence \uE200cite\uE202turn0file2.\uE201")).toBe("Final sentence.");
    expect(cleanCitedText("Final sentence.\uE200cite\uE202turn0file2.\uE201")).toBe("Final sentence.");
    expect(cleanCitedText("Final sentence \uE200cite\uE202turn0file2.\uE201.")).toBe("Final sentence.");
    const extracted = extractCitedAnswer(response(
      "Final sentence \uE200cite\uE202turn0file2.\uE201",
      [{ type: "file_citation", file_id: "file-2", filename: "minutes.pdf" }]
    ), false);
    expect(extracted.answer).toBe("Final sentence.");
  });
  it("drops a remedial-action plan from the displayed citations", () => {
    const result = extractCitedAnswer(response("Quiet hours are in the Village Code.", [
      { type: "file_citation", file_id: "file-rap", filename: "2020-05-18_VillageBoard__24_2_-Remedial_Action_Plan.pdf", index: 10 },
      { type: "file_citation", file_id: "file-code", filename: "village-code.pdf", index: 20 },
    ]), false);
    expect(result.citations.map((citation) => citation.filename)).toEqual(["village-code.pdf"]);
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
  it("turns an email address into a mailto link and leaves the following period", () => {
    const parts = answerSegments("Write to clerkwaters@oak-park.us.", [], "oak-park-il");
    expect(parts.find((part) => part.href)).toEqual({ text: "clerkwaters@oak-park.us", href: "mailto:clerkwaters@oak-park.us" });
    expect(parts.at(-1)?.text).toBe(".");
    expect(externalLinkProps("mailto:clerkwaters@oak-park.us")).toEqual({});
    expect(externalLinkProps("https://www.oak-park.us/")).toEqual({ target: "_blank", rel: "noopener noreferrer" });
  });
  it("links an official page when the answer names it without a URL", () => {
    const parts = answerSegments(
      "Use the Village's garbage collection page and the Lakeshore Recycling Systems Oak Park page.",
      [],
      "oak-park-il"
    );
    expect(parts.filter((part) => part.href).map((part) => part.href)).toEqual([
      "https://www.oak-park.us/Services-Parking/Waste-Recycling/Garbage-Collection",
      "https://www.lrsrecycles.com/municipality/oak-park/",
    ]);
    expect(answerSegments("the garbage collection page", [], "strawberry-point-ia").every((part) => !part.href)).toBe(true);
  });
});
