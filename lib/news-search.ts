import type OpenAI from "openai";
import { allowedAnswerUrl, citationUrlForFile, excludedCitationFilename, officialMentions, safeHttpsUrl } from "@/lib/source-links";
import { uiLocale } from "@/lib/ui-locale";

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

const CITATION_MARKER = /\uE200(?:cite|filecite)\uE202([^\uE201]*)\uE201/g;
const SPACE_BEFORE_PUNCTUATION = /[ \t\u00A0\u2000-\u200A]+([.,;:!?])/g;
const EXTRA_SPACES = /[ \t\u00A0\u2000-\u200A]{2,}/g;
const TRAILING_SPACE = /[ \t\u00A0\u2000-\u200A]+(?=\n|$)/g;
const HORIZONTAL_SPACE = /[ \t\u00A0\u2000-\u200A]/;

/**
 * File-search markers sometimes swallow the sentence punctuation that sat
 * against them (`day \uE200cite\uE202turn0file0.\uE201`). Keep that punctuation
 * unless the text on either side already has it.
 */
function punctuationKeptFromMarker(inner: string, before: string, after: string): string {
  const trailing = inner.match(/[.,;:!?]+$/)?.[0] ?? "";
  if (!trailing) return "";
  const previous = before.match(new RegExp(`([.,;:!?])${HORIZONTAL_SPACE.source}*$`));
  if (previous && trailing.startsWith(previous[1])) return "";
  const next = after.match(new RegExp(`^${HORIZONTAL_SPACE.source}*([.,;:!?])`));
  if (next && trailing.endsWith(next[1])) return "";
  return trailing;
}

function atParagraphBoundary(after: string) {
  return new RegExp(`^${HORIZONTAL_SPACE.source}*(?:\\n|$)`).test(after);
}

function endsWithSentencePunctuation(before: string) {
  return new RegExp(`[.!?…]["')\\]]*${HORIZONTAL_SPACE.source}*$`).test(before);
}

/**
 * File-search citations are trained to land at the end of a paragraph. When the
 * marker itself has no period, and neither side of it does, the paragraph would
 * otherwise end on the last word. Put the period back only at that boundary.
 */
function markerReplacement(inner: string, before: string, after: string) {
  const kept = punctuationKeptFromMarker(inner, before, after);
  if (kept) return kept;
  if (!atParagraphBoundary(after) || endsWithSentencePunctuation(before)) return "";
  return /[A-Za-z0-9)"'\]]$/.test(before.trimEnd()) ? "." : "";
}

export function cleanCitedText(text: string): string {
  const restored = text.replace(CITATION_MARKER, (match, inner: string, offset: number) =>
    markerReplacement(inner, text.slice(0, offset), text.slice(offset + match.length))
  );
  return restored
    .replace(EXTRA_SPACES, " ")
    .replace(SPACE_BEFORE_PUNCTUATION, "$1")
    .replace(TRAILING_SPACE, "");
}

/**
 * The Responses API often strips `\uE200cite\uE202...\uE201` before we see the
 * text and leaves a `file_citation.index` at that point. A citation at a
 * paragraph break can take the period with it. Restore it when the index sits
 * on that break and the paragraph does not already end with punctuation.
 */
export function restorePeriodsAtFileCitations(text: string, indexes: number[]): string {
  const points = [...new Set(indexes.filter((index) => Number.isInteger(index) && index >= 0 && index <= text.length))]
    .sort((left, right) => right - left);
  let result = text;
  for (const index of points) {
    const before = result.slice(0, index);
    const after = result.slice(index);
    if (!atParagraphBoundary(after) || endsWithSentencePunctuation(before)) continue;
    const trimmed = before.trimEnd();
    if (!/[A-Za-z0-9)"'\]]$/.test(trimmed)) continue;
    result = `${trimmed}.${before.slice(trimmed.length)}${after}`;
  }
  return result;
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

function clippedNote(answer: string) {
  return uiLocale(answer) === "es"
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
      const fileIndexes: number[] = [];
      for (const annotation of content.annotations) {
        if (annotation.type === "file_citation") {
          if (Number.isInteger(annotation.index)) fileIndexes.push(annotation.index);
          if (excludedCitationFilename(annotation.filename)) continue;
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
      const citationIndexes = fileIndexes.map((index) => {
        let shifted = index;
        for (const replacement of replacements) {
          if (replacement.end <= index) shifted += replacement.marker.length - (replacement.end - replacement.start);
        }
        return shifted;
      });
      let boundary = text.length;
      for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
        if (replacement.end > boundary) continue;
        text = text.slice(0, replacement.start) + replacement.marker + text.slice(replacement.end);
        boundary = replacement.start;
      }
      // Inline markers still carry the citation. Once the API has removed them,
      // the file_citation index is the only place the missing period can be found.
      if (!text.includes("\uE200")) text = restorePeriodsAtFileCitations(text, citationIndexes);
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
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LINKABLE = new RegExp(`${PLAIN_URL.source}|${EMAIL.source}`, "g");

function safeMailto(value: string): string | null {
  if (!new RegExp(`^${EMAIL.source}$`).test(value)) return null;
  if (value.length > 254) return null;
  return `mailto:${value}`;
}

type TextLink = { start: number; end: number; text: string; href?: string };

function linkifyPlainText(text: string, slug?: string): AnswerSegment[] {
  const found: TextLink[] = [];
  for (const match of text.matchAll(LINKABLE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const trimmed = raw.replace(/[.,;:!?]+$/g, "");
    const href = raw.startsWith("https://")
      ? (slug ? allowedAnswerUrl(trimmed, slug) : null) ?? approvedNewspaperUrl(trimmed)
      : safeMailto(trimmed);
    found.push(href
      ? { start, end: start + trimmed.length, text: trimmed, href }
      : { start, end: start + raw.length, text: raw });
  }
  if (slug) {
    for (const mention of officialMentions(slug)) {
      for (const match of text.matchAll(mention.pattern)) {
        const start = match.index ?? 0;
        found.push({ start, end: start + match[0].length, text: match[0], href: mention.url });
      }
    }
  }
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const parts: AnswerSegment[] = [];
  let last = 0;
  for (const link of found) {
    if (link.start < last) continue;
    if (link.start > last) parts.push({ text: text.slice(last, link.start) });
    parts.push(link.href ? { text: link.text, href: link.href } : { text: link.text });
    last = link.end;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts.filter((part) => part.text.length > 0);
}

export function externalLinkProps(href: string): { target?: "_blank"; rel?: string } {
  if (href.startsWith("mailto:")) return {};
  return { target: "_blank", rel: "noopener noreferrer" };
}

export function answerSegments(text: string, citations: ChatCitation[] = [], slug?: string): AnswerSegment[] {
  return splitNewsReferences(text, citations).flatMap((part) => {
    if (part.citation?.url) return [{ text: part.text, href: part.citation.url }];
    return linkifyPlainText(part.text, slug);
  });
}
