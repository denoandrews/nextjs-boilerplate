import type OpenAI from "openai";

const NEWSPAPER_DOMAINS = ["oakpark.com", "chicagotribune.com"];

export type ChatCitation = {
  fileId: string;
  filename: string;
  url?: string;
  marker?: string;
};

export function newspaperDomains(slug: string): string[] {
  return slug === "oak-park-il" ? [...NEWSPAPER_DOMAINS] : [];
}

export function approvedNewspaperUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (!NEWSPAPER_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function extractCitedAnswer(response: OpenAI.Responses.Response, allowNews: boolean) {
  const citations = new Map<string, ChatCitation>();
  const paragraphs: string[] = [];
  let newsNumber = 0;
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type !== "output_text") continue;
      const replacements: { start: number; end: number; marker: string }[] = [];
      for (const annotation of content.annotations) {
        if (annotation.type === "file_citation") {
          citations.set(annotation.file_id, { fileId: annotation.file_id, filename: annotation.filename });
        } else if (annotation.type === "url_citation" && allowNews) {
          const url = approvedNewspaperUrl(annotation.url);
          if (!url) continue;
          let citation = citations.get(url);
          if (!citation) {
            newsNumber += 1;
            citation = {
              fileId: url,
              filename: annotation.title || new URL(url).hostname,
              url,
              marker: `[News ${newsNumber}]`,
            };
            citations.set(url, citation);
          }
          if (Number.isInteger(annotation.start_index) && Number.isInteger(annotation.end_index) &&
              annotation.start_index >= 0 && annotation.end_index > annotation.start_index &&
              annotation.end_index <= content.text.length) {
            replacements.push({ start: annotation.start_index, end: annotation.end_index, marker: citation.marker! });
          }
        }
      }
      let text = content.text;
      let boundary = text.length;
      for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
        if (replacement.end > boundary) continue;
        text = text.slice(0, replacement.start) + replacement.marker + text.slice(replacement.end);
        boundary = replacement.start;
      }
      // Drop provider-only markup. The file sources and validated news links are rendered separately.
      paragraphs.push(text.replace(/\uE200(?:cite|filecite)\uE202[^\uE201]*\uE201/g, ""));
    }
  }
  return {
    answer: paragraphs.join("\n\n").trim(),
    citations: [...citations.values()],
    newsSearched: allowNews && response.output.some((item) => item.type === "web_search_call"),
  };
}

export function splitNewsReferences(text: string, citations: ChatCitation[] = []) {
  const links = new Map(citations.filter((citation) => citation.marker && citation.url && approvedNewspaperUrl(citation.url))
    .map((citation) => [citation.marker!, citation]));
  return text.split(/(\[News \d+\])/g).filter(Boolean).map((part) => ({ text: part, citation: links.get(part) }));
}
