import type OpenAI from "openai";
import { allowedAnswerUrl, citationUrlForFile, safeHttpsUrl } from "@/lib/source-links";

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

const CITATION_MARKER = /\uE200(?:cite|filecite)\uE202[^\uE201]*\uE201/g;
const SPACE_BEFORE_PUNCTUATION = /[ \t\u00A0\u2000-\u200A]+([.,;:!?])/g;
const EXTRA_SPACES = /[ \t\u00A0\u2000-\u200A]{2,}/g;

export function cleanCitedText(text: string): string {
  return text
    .replace(CITATION_MARKER, "")
    .replace(EXTRA_SPACES, " ")
    .replace(SPACE_BEFORE_PUNCTUATION, "$1");
}

function attributeUrl(attributes: { [key: string]: string | number | boolean } | null | undefined) {
  if (!attributes) return null;
  for (const key of ["source_url", "url", "external_url"]) {
    const value = attributes[key];
    if (typeof value === "string") return value;
  }
  return null;
}

function fileAttributeUrls(response: OpenAI.Responses.Response) {
  const urls = new Map<string, string>();
  for (const item of response.output) {
    if (item.type !== "file_search_call" || !item.results) continue;
    for (const result of item.results) {
      if (!result.file_id || urls.has(result.file_id)) continue;
      const raw = attributeUrl(result.attributes);
      if (!raw) continue;
      const safe = safeHttpsUrl(raw);
      if (safe) urls.set(result.file_id, safe);
    }
  }
  return urls;
}

function looksSpanish(answer: string) {
  if (/[¿¡ñÑ]/.test(answer)) return true;
  const hits = answer.match(/\b(el|la|los|las|que|para|como|cómo|una|ordenanza)\b/gi);
  return (hits?.length ?? 0) >= 2;
}

function clippedNote(answer: string) {
  return looksSpanish(answer)
    ? "El resto de la respuesta se cortó. Pide una continuación si necesitas más."
    : "The rest of this answer was cut off. Ask a follow-up if you need more.";
}

export function closeTruncatedAnswer(answer: string, incomplete: boolean): string {
  const trimmed = answer.trim();
  if (!incomplete || !trimmed) return trimmed;
  const endsClean = /[.!?…]["')\]]*$/.test(trimmed);
  let body = trimmed;
  if (!endsClean) {
    const sentence = /[.!?]["')\]]*/g;
    let end = -1;
    for (const match of trimmed.matchAll(sentence)) {
      const at = (match.index ?? 0) + match[0].length;
      if (at >= 20) end = at;
    }
    if (end > 0) body = trimmed.slice(0, end).trim();
  }
  return `${body}\n\n${clippedNote(body)}`;
}

export function extractCitedAnswer(
  response: OpenAI.Responses.Response,
  allowNews: boolean,
  options?: { slug?: string }
) {
  const citations = new Map<string, ChatCitation>();
  const attributeUrls = fileAttributeUrls(response);
  const paragraphs: string[] = [];
  let newsNumber = 0;
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type !== "output_text") continue;
      const replacements: { start: number; end: number; marker: string }[] = [];
      for (const annotation of content.annotations) {
        if (annotation.type === "file_citation") {
          const url = citationUrlForFile({
            slug: options?.slug,
            filename: annotation.filename,
            attributeUrl: attributeUrls.get(annotation.file_id),
          });
          citations.set(annotation.file_id, {
            fileId: annotation.file_id,
            filename: annotation.filename,
            ...(url ? { url } : {}),
          });
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
      paragraphs.push(cleanCitedText(text));
    }
  }
  const incomplete = response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens";
  return {
    answer: closeTruncatedAnswer(paragraphs.join("\n\n").trim(), incomplete),
    citations: [...citations.values()],
    newsSearched: allowNews && response.output.some((item) => item.type === "web_search_call"),
  };
}

export function splitNewsReferences(text: string, citations: ChatCitation[] = []) {
  const links = new Map(citations.filter((citation) => citation.marker && citation.url && approvedNewspaperUrl(citation.url))
    .map((citation) => [citation.marker!, citation]));
  return text.split(/(\[News \d+\])/g).filter(Boolean).map((part) => ({ text: part, citation: links.get(part) }));
}

export type AnswerSegment = { text: string; href?: string };

const PLAIN_URL = /https:\/\/[^\s<>"')\]]+/g;

function linkifyPlainText(text: string, slug?: string): AnswerSegment[] {
  const parts: AnswerSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(PLAIN_URL)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const trimmed = raw.replace(/[.,;:!?]+$/g, "");
    const href = (slug ? allowedAnswerUrl(trimmed, slug) : null) ?? approvedNewspaperUrl(trimmed);
    if (start > last) parts.push({ text: text.slice(last, start) });
    if (href) {
      parts.push({ text: trimmed, href });
      last = start + trimmed.length;
    } else {
      parts.push({ text: raw });
      last = start + raw.length;
    }
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts.filter((part) => part.text.length > 0);
}

export function answerSegments(text: string, citations: ChatCitation[] = [], slug?: string): AnswerSegment[] {
  return splitNewsReferences(text, citations).flatMap((part) => {
    if (part.citation?.url) return [{ text: part.text, href: part.citation.url }];
    return linkifyPlainText(part.text, slug);
  });
}
