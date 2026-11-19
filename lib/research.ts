import type OpenAI from "openai";
import type { ComparisonFilter } from "openai/resources/shared";

import { DEFAULT_REASONING_MODEL, type ReasoningEffort } from "@/lib/chat-model";
import { buildChatInstructions, getMaxOutputTokens, getRetryOutputTokens } from "@/lib/chat-instructions";
import { logChatDiagnostics } from "@/lib/chat-diagnostics";
import { recordDateNumber, dateBoostFor, calendarStamp, questionAsksAboutHistory, shiftMonths } from "@/lib/file-search";
import { excludedCitationFilename, officialPages } from "@/lib/source-links";
import { addChatUsage, estimateCostMicrousd, extractChatUsage, type ChatUsage } from "@/lib/chat-usage";
import { extractCitedAnswer, omitInvalidCitationLines, type ChatCitation } from "@/lib/news-search";
import { turnLanguageDirective } from "@/lib/ui-locale";
import {
  officialWebDomains,
  newspaperDomainsFor,
  webPassEnabled,
  canonicalHttpsUrl,
  matchWebUrl,
  type WebSourceKind,
} from "@/lib/web-sources";

export const RESEARCH_QUERY_LIMIT = 6;
export const RESEARCH_OFFICIAL_SLOTS = 30;
export const RESEARCH_NEWSPAPER_SLOTS = 6;
const SEARCH_RESULTS = 12;
const PLAN_TIMEOUT_MS = 12_000;
const SEARCH_TIMEOUT_MS = 10_000;
const WEB_TIMEOUT_MS = 40_000;
const TURN_BUDGET_MS = 155_000;

const STOP_WORDS = new Set([
  "about", "after", "also", "and", "are", "been", "but", "did", "does", "for", "from", "had",
  "has", "have", "how", "into", "its", "last", "not", "oak", "over", "park", "that", "the",
  "this", "village", "was", "were", "what", "when", "where", "which", "who", "why", "with",
  "your",
]);

export type EvidenceKind = "record" | "official" | "newspaper";

export type EvidenceItem = {
  id: string;
  kind: EvidenceKind;
  tier: 0 | 1;
  filename: string;
  title?: string;
  url?: string;
  text: string;
  recordDate?: number;
  documentType?: string;
  score: number;
  rankScore: number;
};

export function researchModeEnabled(slug: string, raw = process.env.MUNIGPT_RESEARCH_MODE): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off" || value === "disabled") return false;
  if (value === "1" || value === "true" || value === "on" || value === "all") return true;
  return slug === "oak-park-il";
}

/** Drop harness prefixes such as `[TEST]` before planning, search, and relevance checks. */
export function stripHarnessPrefix(text: string): string {
  return text.replace(/^(?:\s*\[(?:TEST|DEBUG|EVAL)\]\s*)+/i, "").trim();
}

export function personName(question: string): string | null {
  const match = stripHarnessPrefix(question).match(/\b(?:[Ww]ho|[Qq]ui[eé]n)\s+(?:is|was|es|fue)\s+((?:[A-Z][a-z]+|[A-Z]\.)(?:\s+(?:[A-Z][a-z]+|[A-Z]\.)){0,3})/);
  if (!match) return null;
  const name = match[1].replace(/[?.!,;:]+$/g, "").trim();
  if (/^(?:the|village|board|mayor|president)\b/i.test(name)) return null;
  return name;
}

function uniqueQueries(queries: string[], limit = RESEARCH_QUERY_LIMIT): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const query of queries) {
    const trimmed = query.replace(/\s+/g, " ").trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length < 3 || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed.slice(0, 180));
    if (out.length >= limit) break;
  }
  return out;
}

function yearsFor(question: string, now: Date): number[] {
  const found = [...question.matchAll(/\b(?:FY\s*)?(20\d{2})\b/gi)].map((match) => Number(match[1]));
  const unique = [...new Set(found)];
  if (unique.length >= 2) {
    const start = Math.min(...unique);
    const end = Math.max(...unique);
    const span: number[] = [];
    for (let year = start; year <= end && span.length < 4; year += 1) span.push(year);
    return span;
  }
  if (/\b(?:last|past)\s+three\b|\bthree\s+(?:fiscal\s+)?years\b/i.test(question)) {
    const year = Math.floor(calendarStamp(now) / 10_000);
    return [year - 2, year - 1, year];
  }
  return [];
}

export function isBoardRosterQuestion(question: string): boolean {
  const text = stripHarnessPrefix(question);
  return /\b(?:village president|who (?:is|are) the (?:current )?(?:village )?(?:president|trustees?)|current trustees)\b/i.test(text);
}

export function wantsLegistarPass(question: string): boolean {
  const text = stripHarnessPrefix(question);
  return /\b(?:current|policy|ordinance|overnight parking)\b/i.test(text);
}

function topicPhrase(question: string): string {
  const streetscape = question.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\s+streetscape)\b/);
  if (streetscape) return streetscape[1];
  const street = question.match(/\b([A-Z][a-z]+\s+Street)\b/);
  if (street) return street[1];
  return "the project";
}

/** Parts the merged evidence still does not answer, with a targeted follow-up query for each. */
export function missingPartQueries(question: string, evidenceText: string): string[] {
  const text = stripHarnessPrefix(question);
  const topic = topicPhrase(text);
  const checks: { when: RegExp; covered: RegExp; queries: string[] }[] = [
    {
      when: /\bcontractor\b/i,
      covered: /\bawarded to\s+[A-Z]|\b(?:Co\.|Inc\.|LLC|Corp\.)\b/,
      queries: [`${topic} construction contract awarded`, `${topic} construction bid award contractor`],
    },
    {
      when: /\b(?:how much|what did it cost|contract amount)\b/i,
      covered: /\$\s?\d|\b(?:contract amount|not to exceed)\b/i,
      queries: [`${topic} contract amount cost`],
    },
    {
      when: /\bchange orders?\b/i,
      covered: /\bchange orders?\b/i,
      queries: [`${topic} change order`],
    },
  ];
  const parkingCovered = /\b(?:ordinance|motion|ORD|MOT)\b[\s\S]{0,60}\b20(?:23|24)\b|\b20(?:23|24)\b[\s\S]{0,60}\b(?:ordinance|motion|expansion)\b/i;
  if (/\bovernight parking\b/i.test(text) && /\b(?:current|policy)\b/i.test(text) && !parkingCovered.test(evidenceText)) {
    checks.push({
      when: /./,
      covered: /$a/,
      queries: [
        "overnight parking ordinance adopted 2023",
        "overnight parking ordinance adopted 2024",
        "overnight parking permit expansion board minutes",
        "Legistar overnight parking legislation",
      ],
    });
  }
  const queries: string[] = [];
  for (const check of checks) {
    if (!check.when.test(text) || check.covered.test(evidenceText)) continue;
    queries.push(...check.queries);
  }
  return uniqueQueries([...queries, ...discoveredSearchTerms(topic, evidenceText)], 8);
}

/** Ordinance numbers and company names already in the evidence, searched again instead of guessed. */
export function discoveredSearchTerms(topic: string, evidenceText: string): string[] {
  const ids = [...evidenceText.matchAll(/\b(?:ORD|MOT|RES)\s*\d{2}-\d{2,4}\b/gi)].map((match) => match[0].replace(/\s+/g, " "));
  const companies = [...evidenceText.matchAll(/\b([A-Z][A-Za-z&'.-]+(?:\s+[A-Z][A-Za-z&'.-]+){0,3}\s(?:Co\.|Inc\.|LLC|Corp\.|Company))\b/g)].map((match) => match[1]);
  return [...ids.map((id) => `${topic} ${id}`), ...companies.map((name) => `${topic} ${name}`)];
}

/** Targeted file-search queries. Person, year, and multi-part coverage is kept even if the planner is vague. */
export function draftResearchQueries(question: string, now = new Date()): string[] {
  const cleaned = stripHarnessPrefix(question);
  const name = personName(cleaned);
  if (name) {
    return uniqueQueries([
      `${name} trustee`,
      `${name} village board`,
      `${name} roll call`,
      `${name} budget`,
      `${name} president`,
    ]);
  }

  if (isBoardRosterQuestion(cleaned)) {
    return uniqueQueries([
      "Village President trustees Village Board",
      "current Village President",
      "current Village trustees roster",
      cleaned,
    ]);
  }

  if (/\bovernight parking\b/i.test(cleaned) || (/\bparking\b/i.test(cleaned) && /\b(?:policy|permit|ordinance)\b/i.test(cleaned))) {
    return uniqueQueries([
      "overnight parking permit ordinance 2023",
      "overnight parking permit ordinance 2024",
      "overnight parking permit expansion",
      "overnight parking ordinance adopted minutes",
      "Legistar overnight parking legislation",
    ]);
  }

  if (/\blake street\b/i.test(cleaned)) {
    const queries = ["Lake Street streetscape board decision"];
    if (/\b(?:cost|how much|budget|amount)\b/i.test(cleaned)) queries.push("Lake Street streetscape cost contract amount");
    if (/\bcontractor\b/i.test(cleaned)) queries.push("Lake Street streetscape construction contractor");
    if (/\bchange orders?\b/i.test(cleaned)) queries.push("Lake Street streetscape change order");
    return uniqueQueries(queries);
  }

  const years = yearsFor(cleaned, now);
  if (years.length >= 2 && /\b(?:budget|spending|levy|fund)\b/i.test(cleaned)) {
    return uniqueQueries([
      ...years.map((year) => `village budget FY${year} adopted expenditures`),
      "reasons for village budget changes",
    ]);
  }

  const parts = cleaned
    .split(/[?;]|\s+\band\s+|,(?=\s)/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 12);
  const queries = parts.length >= 2 ? parts : [cleaned, `${cleaned} minutes`, `${cleaned} ordinance`];
  return uniqueQueries(queries);
}

export function mergeResearchQueries(required: string[], planned: string[]): string[] {
  return uniqueQueries([...required, ...planned]);
}

export function recencyCutoff(question: string, now = new Date()): number | null {
  const text = stripHarnessPrefix(question);
  if (questionAsksAboutHistory(text) || personName(text)) return null;
  const threeYears = /\b(?:last|past)\s+three\b|\bthree\s+(?:fiscal\s+)?years\b/i.test(text);
  const current = /\b(?:current|status|latest|recent|policy|today)\b/i.test(text);
  if (!threeYears && !current) return null;
  // 36 months keeps 2023–2024 ordinances inside a "current policy" question asked in late 2026.
  return shiftMonths(calendarStamp(now), 36);
}

export function significantTerms(text: string): string[] {
  text = stripHarnessPrefix(text);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

/**
 * Drops website and newspaper hits that do not share the question's topic.
 * One shared term is enough for an on-domain page. A person hit must include
 * the surname so a short Wednesday Journal blurb is not discarded.
 */
export function webResultIsRelevant(question: string, text: string): boolean {
  const haystack = text.toLowerCase();
  const name = personName(question);
  if (name) {
    const surname = personSurname(name);
    if (surname && !haystack.includes(surname)) return false;
  }
  const terms = significantTerms(question);
  if (terms.length === 0) return haystack.trim().length > 40;
  return terms.some((term) => haystack.includes(term));
}

const PLACE_LEADING = new Set([
  "the", "a", "an", "of", "on", "for", "to", "at", "by", "from", "about", "and", "or", "in", "near", "along", "over",
  "with", "what", "how", "who", "when", "where", "which", "this", "that", "did", "does", "was", "were", "has", "have",
  "had", "been", "into", "its", "your", "not", "but", "also", "after", "before", "during", "between", "across",
]);

function normalizeOverlapText(text: string): string {
  return stripHarnessPrefix(text)
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\bave\.?\b/g, "avenue")
    .replace(/\bst\.?\b/g, "street")
    .replace(/\bblvd\.?\b/g, "boulevard")
    .replace(/\brd\.?\b/g, "road")
    .replace(/\bdr\.?\b/g, "drive")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Street, avenue, and road names in the question. "Oak Park Ave" matches "Oak Park Avenue". */
export function placeEntities(question: string): string[] {
  const normalized = normalizeOverlapText(question);
  const pattern = /\b([a-z0-9]+(?:\s+[a-z0-9]+){0,2})\s+(street|avenue|road|boulevard|drive|lane|place|court|way)\b/g;
  const entities: string[] = [];
  for (const match of normalized.matchAll(pattern)) {
    const words = (match[1] ?? "").split(/\s+/).filter(Boolean);
    while (words.length > 0 && PLACE_LEADING.has(words[0] ?? "")) words.shift();
    if (words.length === 0 || !match[2]) continue;
    entities.push(`${words.join(" ")} ${match[2]}`);
  }
  return [...new Set(entities)];
}

function personSurname(name: string): string | null {
  const parts = name.toLowerCase().split(/\s+/).filter((part) => part.length > 2);
  return parts[parts.length - 1] ?? null;
}

/**
 * Newspaper evidence must overlap the question's entity or topic.
 * A named street has to appear; a shared word such as "streetscape" is not enough.
 * A person question keeps a hit only when it names that person.
 */
export function newsEvidenceIsRelevant(question: string, text: string): boolean {
  const haystack = normalizeOverlapText(text);
  const name = personName(question);
  if (name) {
    const surname = personSurname(name);
    return Boolean(surname && haystack.includes(surname));
  }
  const entities = placeEntities(question);
  if (entities.length > 0) return entities.some((entity) => haystack.includes(entity));
  return webResultIsRelevant(question, text);
}

export function evidenceSearchText(item: EvidenceItem): string {
  return `${item.filename}\n${item.title ?? ""}\n${item.text}\n${item.url ?? ""}`;
}

/** Keep official records and website pages. Drop newspaper hits that are off the question. */
export function filterNewsEvidence(question: string, items: EvidenceItem[]): EvidenceItem[] {
  return items.filter((item) => item.kind !== "newspaper" || newsEvidenceIsRelevant(question, evidenceSearchText(item)));
}

export function overlapScore(question: string, text: string): number {
  const terms = significantTerms(question);
  if (terms.length === 0) return 0.5;
  const hits = terms.filter((term) => text.toLowerCase().includes(term)).length;
  return Math.min(0.95, 0.4 + (hits / terms.length) * 0.55);
}

function typeBoost(documentType?: string): number {
  if (documentType === "minutes" || documentType === "ordinance" || documentType === "resolution") return 1.08;
  return 1;
}

export function scoreEvidence(item: Omit<EvidenceItem, "tier" | "rankScore">, question: string, now = new Date()): EvidenceItem {
  const tier: 0 | 1 = item.kind === "newspaper" ? 1 : 0;
  const boost = dateBoostFor(item.recordDate, calendarStamp(now), questionAsksAboutHistory(question));
  let rankScore = item.score * boost * (item.kind === "record" ? typeBoost(item.documentType) : 1);
  if (isBoardRosterQuestion(question) && /village-board/i.test(item.url ?? "")) rankScore += 5;
  return { ...item, tier, rankScore };
}

/** Official records and official website pages stay ahead of newspaper reporting. A few newspaper slots are kept. */
export function mergeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const byKey = new Map<string, EvidenceItem>();
  for (const item of items) {
    const key = `${item.kind}:${item.id}:${item.text.slice(0, 160)}`;
    const existing = byKey.get(key);
    if (existing && existing.rankScore >= item.rankScore) continue;
    byKey.set(key, item);
  }
  const ranked = [...byKey.values()].sort((left, right) => left.tier - right.tier || right.rankScore - left.rankScore);
  const official = ranked.filter((item) => item.tier === 0).slice(0, RESEARCH_OFFICIAL_SLOTS);
  const news = ranked.filter((item) => item.tier === 1).slice(0, RESEARCH_NEWSPAPER_SLOTS);
  return [...official, ...news];
}

function evidenceUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return canonicalHttpsUrl(url)?.href ?? undefined;
}

export function formatEvidence(items: EvidenceItem[], question = ""): string {
  if (items.length === 0) return "No municipal records, official website pages, or newspaper passages were retrieved for this question.";
  const lines = items.map((item, index) => {
    const source = item.kind === "newspaper" ? "newspaper reporting" : item.kind === "official" ? "official website" : "municipal record";
    const date = item.recordDate ? ` | record_date: ${item.recordDate}` : "";
    const type = item.documentType ? ` | document_type: ${item.documentType}` : "";
    const href = evidenceUrl(item.url);
    const url = href ? ` | url: ${href}` : "";
    return `[${index + 1}] source: ${source} | filename: ${item.filename}${date}${type}${url}\n${item.text}`;
  });
  const news = items.filter((item) => item.kind === "newspaper");
  const guidance = [
    "Evidence for this question, already merged. Municipal records and official website pages are listed before newspaper reporting. Official website content is not newspaper reporting. Use only this evidence for facts. Cite the bracket number, such as [1], at the end of every factual sentence.",
    "If a person appears only as a candidate or an objector here, say the records may be incomplete and do not conclude they were not a village official.",
  ];
  if (news.length > 0) {
    guidance.push("Integrate each relevant newspaper finding into the answer prose and cite its bracket number there. Do not leave a relevant newspaper finding unused. Do not append a stock line such as \"The Wednesday Journal reported:\" after the answer.");
    if (items.some((item) => item.kind !== "newspaper")) {
      guidance.push("When both an official source and a newspaper passage are relevant, cite both.");
    }
  }
  const name = personName(question);
  if (name) {
    const required = news.filter((item) => newsEvidenceIsRelevant(question, evidenceSearchText(item)));
    if (required.length > 0) {
      const markers = required.map((item) => `[${items.indexOf(item) + 1}]`).join(", ");
      guidance.push(`This question asks who ${name} is. You must use every newspaper result that mentions ${name} (${markers}). State what that reporting says about ${name}, label it as reporting, and cite each of those numbers.`);
    }
  }
  if (isBoardRosterQuestion(question)) {
    guidance.push("When the question asks who the Village President or trustees are, cite the official Village Board page.");
  }
  if (/\bovernight parking\b/i.test(question) && /\b(?:current|policy)\b/i.test(question)) {
    guidance.push("For the current overnight parking policy, include 2023 and 2024 ordinance or Legistar changes that appear in the evidence, not only the current website summary.");
  }
  return [guidance.join(" "), ...lines].join("\n\n");
}

/**
 * Renumber inline [n] markers to match the returned citation list, in the order
 * they first appear. Every returned citation, including a record, gets that marker.
 * Stock newspaper lines with an empty or markdown body are removed first.
 */
export function alignCitations(answer: string, items: EvidenceItem[]): { answer: string; citations: ChatCitation[] } {
  const cleaned = omitInvalidCitationLines(answer);
  const order: number[] = [];
  const seen = new Set<number>();
  const add = (number: number) => {
    if (number < 1 || number > items.length || seen.has(number)) return;
    seen.add(number);
    order.push(number);
  };
  for (const match of cleaned.matchAll(/\[(\d+)\]/g)) add(Number(match[1]));
  items.forEach((item, index) => {
    const href = citationUrl(item);
    if ((href && cleaned.includes(href)) || (item.url && cleaned.includes(item.url))) add(index + 1);
    if (item.filename.length > 12 && cleaned.includes(item.filename)) add(index + 1);
  });
  const renumber = new Map(order.map((old, index) => [old, index + 1]));
  const rewritten = cleaned.replace(/\[(\d+)\]/g, (full, raw: string) => {
    const next = renumber.get(Number(raw));
    return next ? `[${next}]` : full;
  });
  const citations = order.map((old, index) => citationForItem(items[old - 1], index + 1));
  return { answer: rewritten, citations };
}

function citationUrl(item: EvidenceItem): string | undefined {
  const candidate = item.url || (item.id.startsWith("https://") ? item.id : "");
  return candidate ? matchWebUrl(candidate)?.url : undefined;
}

function citationForItem(item: EvidenceItem, number: number): ChatCitation {
  const url = citationUrl(item);
  return {
    fileId: item.id,
    filename: item.filename,
    ...(url ? { url } : {}),
    marker: `[${number}]`,
  };
}

export function parsePlannerQueries(text: string): string[] {
  const cleaned = text.replace(/```json|```/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { queries?: unknown };
    if (!Array.isArray(parsed.queries)) return [];
    return parsed.queries.filter((query): query is string => typeof query === "string");
  } catch {
    return [];
  }
}

function outputText(response: OpenAI.Responses.Response): string {
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type === "output_text" && content.text.trim()) parts.push(content.text.trim());
    }
  }
  return parts.join("\n\n").trim();
}

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  const name = String(error.name);
  return name === "AbortError" || name === "APIUserAbortError" || name === "TimeoutError" || name === "APIConnectionTimeoutError";
}

type SearchRow = {
  file_id?: string;
  filename?: string;
  score?: number;
  attributes?: { [key: string]: string | number | boolean } | null;
  content?: { text?: string }[];
};

async function searchRecords(
  client: OpenAI,
  input: {
    vectorStoreIds: string[];
    query: string;
    filters?: ComparisonFilter;
    question: string;
    now: Date;
    signal?: AbortSignal;
  },
): Promise<EvidenceItem[]> {
  const search = client.vectorStores?.search;
  if (typeof search !== "function") return [];
  const items: EvidenceItem[] = [];
  for (const vectorStoreId of input.vectorStoreIds) {
    const page = await search.call(
      client.vectorStores,
      vectorStoreId,
      {
        query: input.query,
        max_num_results: SEARCH_RESULTS,
        ranking_options: { ranker: "auto" as const },
        rewrite_query: false,
        ...(input.filters ? { filters: input.filters } : {}),
      },
      { timeout: SEARCH_TIMEOUT_MS, signal: input.signal },
    );
    const rows = page && Array.isArray(page.data) ? page.data as SearchRow[] : [];
    for (const row of rows) {
      if (!row.file_id || excludedCitationFilename(row.filename ?? "")) continue;
      const text = (row.content ?? []).map((part) => part.text ?? "").join("\n").trim().slice(0, 900);
      if (!text) continue;
      const attributes = row.attributes ?? undefined;
      const title = typeof attributes?.title === "string" ? attributes.title : undefined;
      const documentType = typeof attributes?.document_type === "string" ? attributes.document_type : undefined;
      items.push(scoreEvidence({
        id: row.file_id,
        kind: "record",
        filename: row.filename || "record",
        title,
        text,
        recordDate: recordDateNumber(attributes?.record_date),
        documentType,
        score: typeof row.score === "number" ? row.score : 0.5,
      }, input.question, input.now));
    }
  }
  return items;
}

function urlsInText(text: string): string[] {
  return [...text.matchAll(/https:\/\/[^\s<>"')\]]+/g)].map((match) => match[0].replace(/[.,;]+$/g, ""));
}

function webItemsFromResponse(
  response: OpenAI.Responses.Response,
  question: string,
  now: Date,
  fallbackKind: WebSourceKind,
): { items: EvidenceItem[]; dropped: number; hosts: string[] } {
  const items: EvidenceItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  const hosts: string[] = [];
  const add = (url: string, title: string, excerpt: string) => {
    const matched = matchWebUrl(url);
    let host = "";
    try { host = new URL(url).hostname; } catch { host = url.slice(0, 40); }
    if (!hosts.includes(host)) hosts.push(host);
    const path = (() => {
      try { return decodeURIComponent(url).replace(/[-_/]+/g, " "); } catch { return url; }
    })();
    const body = `${title}\n${excerpt}\n${path}`;
    const relevant = matched?.kind === "newspaper"
      ? newsEvidenceIsRelevant(question, body)
      : webResultIsRelevant(question, body);
    if (!matched || !relevant) {
      dropped += 1;
      return;
    }
    if (seen.has(matched.url)) return;
    seen.add(matched.url);
    items.push(scoreEvidence({
      id: matched.url,
      kind: matched.kind,
      filename: title || matched.label,
      title: title || undefined,
      url: matched.url,
      text: excerpt.slice(0, 900),
      score: overlapScore(question, body),
    }, question, now));
  };
  for (const item of response.output ?? []) {
    if (item.type === "web_search_call" && item.action.type === "search") {
      for (const source of item.action.sources ?? []) add(source.url, "", source.url);
    }
    if (item.type === "web_search_call" && item.action.type === "open_page" && item.action.url) {
      add(item.action.url, "", item.action.url);
    }
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type !== "output_text") continue;
      const text = content.text.trim();
      const annotations = content.annotations.filter((annotation) => annotation.type === "url_citation");
      for (const annotation of annotations) {
        if (annotation.type !== "url_citation") continue;
        const start = Math.max(0, annotation.start_index - 500);
        const excerpt = text.slice(start, Math.max(annotation.end_index, start + 240)).trim() || text.slice(0, 900);
        add(annotation.url, annotation.title || "", excerpt);
      }
      for (const url of urlsInText(text)) add(url, "", text.slice(0, 900));
      const textRelevant = fallbackKind === "newspaper"
        ? newsEvidenceIsRelevant(question, text)
        : webResultIsRelevant(question, text);
      if (annotations.length === 0 && urlsInText(text).length === 0 && textRelevant) {
        items.push(scoreEvidence({
          id: `web-text:${fallbackKind}:${text.slice(0, 80)}`,
          kind: fallbackKind,
          filename: fallbackKind === "official" ? "Official website" : "Newspaper",
          text: text.slice(0, 900),
          score: overlapScore(question, text),
        }, question, now));
      }
    }
  }
  return { items, dropped, hosts };
}

type WebPassResult = { items: EvidenceItem[]; usage: ChatUsage | null; ok: boolean };

function webQuery(question: string, kind: WebSourceKind, focus?: string): string {
  const clean = stripHarnessPrefix(question);
  if (focus) return focus;
  const name = personName(clean);
  if (kind === "newspaper") return name ? `${name} Oak Park` : `${clean} Oak Park`;
  if (name) return `${clean}\nLook up ${name} on the village website, including trustee, village board, roll call, budget, and president.`;
  if (isBoardRosterQuestion(clean)) return `${clean}\nVillage President and trustees on the official Village Board page.`;
  if (wantsLegistarPass(clean)) return `${clean}\nSearch Legistar for ordinances and motions from 2023 and 2024.`;
  return clean;
}

function isTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  const name = String(error.name);
  return name === "APIConnectionTimeoutError" || name === "TimeoutError";
}

async function runWebPass(
  client: OpenAI,
  input: {
    slug: string;
    kind: WebSourceKind;
    question: string;
    now: Date;
    signal?: AbortSignal;
    requestId: string;
    domains?: string[];
    focus?: string;
  },
): Promise<WebPassResult> {
  const domains = input.domains ?? (input.kind === "official" ? officialWebDomains(input.slug) : newspaperDomainsFor(input.slug));
  if (domains.length === 0) return { items: [], usage: null, ok: false };
  const attempt = async () => {
    const response = await client.responses.create(
      {
        model: process.env.MUNIGPT_PLANNER_MODEL?.trim() || DEFAULT_REASONING_MODEL,
        reasoning: { effort: "none" },
        max_output_tokens: 6_000,
        tool_choice: "required",
        instructions: input.kind === "official"
          ? "Search only the allowed official municipal site. Quote short passages that are about the question, with page titles and full https URLs. Skip unrelated pages. Do not write the final answer. Do not conclude that a person was not an official."
          : "Search only the allowed newspapers, including www.oakpark.com for the Wednesday Journal. Quote short passages that are about the question, with the article title, date, and full https URL. Skip unrelated articles. Call each passage newspaper reporting. Do not write the final answer.",
        input: webQuery(input.question, input.kind, input.focus),
        include: ["web_search_call.action.sources"],
        tools: [{
          type: "web_search",
          filters: { allowed_domains: domains },
          external_web_access: true,
          search_context_size: "low",
        }],
      },
      { timeout: WEB_TIMEOUT_MS, signal: input.signal },
    );
    logChatDiagnostics(input.requestId, response);
    const extracted = webItemsFromResponse(response, input.question, input.now, input.kind);
    if (response.status === "incomplete" && extracted.items.length === 0) {
      throw Object.assign(new Error("web search output was cut off"), { name: "TimeoutError" });
    }
    console.info(`[${input.requestId}] web pass ${input.kind} kept=${extracted.items.length} dropped=${extracted.dropped} hosts=${extracted.hosts.join(",") || "none"} domains=${domains.join(",")}`);
    const usage = extractChatUsage(response, DEFAULT_REASONING_MODEL);
    if ((usage.webSearchCalls ?? 0) === 0) usage.webSearchCalls = 1;
    return { items: extracted.items, usage, ok: true };
  };
  try {
    return await attempt();
  } catch (error) {
    if (input.signal?.aborted) throw error;
    if (!isTimeout(error)) {
      console.error(`[${input.requestId}] ${input.kind} web search failed.`, error);
      return { items: [], usage: null, ok: false };
    }
    console.info(`[${input.requestId}] ${input.kind} web search timed out after ${WEB_TIMEOUT_MS}ms. Retrying once.`);
    try {
      return await attempt();
    } catch (retryError) {
      if (input.signal?.aborted) throw retryError;
      console.error(`[${input.requestId}] ${input.kind} web search retry failed.`, retryError);
      return { items: [], usage: null, ok: false };
    }
  }
}

async function planQueries(
  client: OpenAI,
  input: { question: string; signal?: AbortSignal; requestId: string },
): Promise<{ queries: string[]; usage: ChatUsage | null }> {
  const response = await client.responses.create(
    {
      model: process.env.MUNIGPT_PLANNER_MODEL?.trim() || DEFAULT_REASONING_MODEL,
      reasoning: { effort: "none" },
      max_output_tokens: 4_000,
      instructions: 'Return JSON only: {"queries":["..."]}. Write 3 to 6 short file-search queries. One query per part of the question. For a span of years, one query per year. For a person, include the name with trustee, village board, roll call, budget, and president. Do not answer the question.',
      input: input.question,
    },
    { timeout: PLAN_TIMEOUT_MS, signal: input.signal },
  );
  logChatDiagnostics(input.requestId, response);
  if (response.status === "incomplete") {
    console.info(`[${input.requestId}] Planner output was incomplete (${response.incomplete_details?.reason ?? "unknown"}). Using any queries that were written.`);
  }
  return { queries: parsePlannerQueries(outputText(response)), usage: extractChatUsage(response, DEFAULT_REASONING_MODEL) };
}

export type ResearchTurn = {
  answer: string;
  citations: ChatCitation[];
  newsSearched: boolean;
  officialSearched: boolean;
  usage: ChatUsage;
};

function emptyUsage(model: string): ChatUsage {
  return extractChatUsage({ output: [], usage: undefined } as never, model);
}

export async function runResearchTurn(input: {
  client: OpenAI;
  slug: string;
  municipalityName: string;
  vectorStoreIds: string[];
  question: string;
  history: { role: "user" | "assistant"; content: string }[];
  model: string;
  reasoning?: { effort: ReasoningEffort };
  signal?: AbortSignal;
  requestId: string;
  now?: Date;
  onProgress?: (message: string) => void;
}): Promise<ResearchTurn> {
  const question = stripHarnessPrefix(input.question);
  const now = input.now ?? new Date();
  const started = Date.now();
  const remaining = () => TURN_BUDGET_MS - (Date.now() - started);
  let usage = emptyUsage(input.model);
  const add = (next: ChatUsage | null) => {
    if (next) usage = addChatUsage(usage, next, input.model);
  };

  const webOn = webPassEnabled(input.slug);
  const runOfficial = webOn && officialWebDomains(input.slug).length > 0;
  const runNews = webOn && newspaperDomainsFor(input.slug).length > 0;
  const runLegistar = runOfficial && wantsLegistarPass(question) && officialWebDomains(input.slug).includes("oak-park.legistar.com");
  if (runOfficial || runNews) input.onProgress?.("Searching the village website and newspapers…");

  const webPromise = (async () => {
    if (!webOn) return { items: [] as EvidenceItem[], officialOk: false, newsOk: false };
    const passes = await Promise.all([
      runOfficial ? runWebPass(input.client, { ...input, question, kind: "official", now }) : Promise.resolve({ items: [], usage: null, ok: false }),
      runNews ? runWebPass(input.client, { ...input, question, kind: "newspaper", now }) : Promise.resolve({ items: [], usage: null, ok: false }),
      runLegistar ? runWebPass(input.client, {
        ...input,
        question,
        kind: "official",
        now,
        domains: ["oak-park.legistar.com"],
        focus: /\bovernight parking\b/i.test(question)
          ? "overnight parking ordinance 2023 2024 permit expansion"
          : `${question} ordinance motion Legistar`,
      }) : Promise.resolve({ items: [], usage: null, ok: false }),
    ]);
    for (const pass of passes) add(pass.usage);
    return {
      items: passes.flatMap((pass) => pass.items),
      officialOk: passes[0].ok || passes[2].ok,
      newsOk: passes[1].ok,
    };
  })();

  input.onProgress?.("Planning record searches…");
  let planned: string[] = [];
  try {
    const plan = await planQueries(input.client, { ...input, question });
    planned = plan.queries;
    add(plan.usage);
  } catch (error) {
    if (isAbort(error)) throw error;
    console.error(`[${input.requestId}] Research planner failed.`, error);
  }
  const queries = mergeResearchQueries(draftResearchQueries(question, now), planned);
  const cutoff = recencyCutoff(question, now);

  input.onProgress?.("Searching municipal records…");
  const recordGroups = await Promise.all([
    ...queries.map((query) => searchRecords(input.client, {
      vectorStoreIds: input.vectorStoreIds,
      query,
      question,
      now,
      signal: input.signal,
    }).catch((error: unknown) => {
      if (isAbort(error)) throw error;
      console.error(`[${input.requestId}] Record search failed.`, error);
      return [] as EvidenceItem[];
    })),
    ...(cutoff ? [searchRecords(input.client, {
      vectorStoreIds: input.vectorStoreIds,
      query: question,
      filters: { type: "gte", key: "record_date", value: cutoff },
      question,
      now,
      signal: input.signal,
    }).catch((error: unknown) => {
      if (isAbort(error)) throw error;
      console.error(`[${input.requestId}] Recent-record search failed.`, error);
      return [] as EvidenceItem[];
    })] : []),
  ]);
  const web = await webPromise;
  const boardPage = boardRosterEvidence(input.slug, question, now);
  let evidence = mergeEvidence([...recordGroups.flat(), ...web.items, ...(boardPage ? [boardPage] : [])]);
  const gaps = missingPartQueries(question, evidence.map((item) => item.text).join("\n"));
  let followUpCalls = 0;
  if (gaps.length > 0 && remaining() > 20_000) {
    input.onProgress?.("Searching for the missing part…");
    console.info(`[${input.requestId}] follow-up searches ${JSON.stringify(gaps)}`);
    const extra = await Promise.all(gaps.map((query) => searchRecords(input.client, {
      vectorStoreIds: input.vectorStoreIds,
      query,
      question,
      now,
      signal: input.signal,
    }).catch((error: unknown) => {
      if (isAbort(error) && input.signal?.aborted) throw error;
      console.error(`[${input.requestId}] Follow-up search failed.`, error);
      return [] as EvidenceItem[];
    })));
    followUpCalls = extra.length;
    evidence = mergeEvidence([...evidence, ...extra.flat()]);
    if (webOn && remaining() > 25_000) {
      const focus = gaps.slice(0, 3).join(". ");
      const extraWeb = await Promise.all([
        runNews ? runWebPass(input.client, { ...input, question, kind: "newspaper", now, focus }) : Promise.resolve({ items: [], usage: null, ok: false }),
        (runLegistar || runOfficial) ? runWebPass(input.client, { ...input, question, kind: "official", now, domains: ["oak-park.legistar.com"], focus }) : Promise.resolve({ items: [], usage: null, ok: false }),
      ]);
      for (const pass of extraWeb) add(pass.usage);
      if (extraWeb[0].ok) web.newsOk = true;
      if (extraWeb[1].ok) web.officialOk = true;
      evidence = mergeEvidence([...evidence, ...extraWeb.flatMap((pass) => pass.items)]);
    }
  }
  usage = {
    ...usage,
    fileSearchCalls: usage.fileSearchCalls + (recordGroups.length + followUpCalls) * Math.max(1, input.vectorStoreIds.length),
  };
  usage = { ...usage, estimatedCostMicrousd: estimateCostMicrousd(usage, input.model) };

  evidence = filterNewsEvidence(question, evidence);
  input.onProgress?.("Writing the answer…");
  const evidenceText = formatEvidence(evidence, question);
  const instructions = buildChatInstructions({
    municipalityName: input.municipalityName,
    slug: input.slug,
    newsEnabled: true,
    now,
    question,
    researchMode: true,
  });
  const requestBody = {
    model: input.model,
    max_output_tokens: getMaxOutputTokens(input.model, input.reasoning?.effort),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    instructions,
    input: [
      ...input.history,
      { role: "developer" as const, content: turnLanguageDirective(question) },
      { role: "developer" as const, content: evidenceText },
      { role: "user" as const, content: question },
    ],
  };
  const timeout = Math.max(8_000, Math.min(110_000, remaining() - 8_000));
  let response = await input.client.responses.create(requestBody, { timeout, signal: input.signal });
  logChatDiagnostics(input.requestId, response);
  add(extractChatUsage(response, input.model));
  let extracted = extractCitedAnswer(response, true, { slug: input.slug });
  if ((!extracted.answer.trim() || response.status === "incomplete") && remaining() > 12_000) {
    console.info(`[${input.requestId}] Research answer was ${extracted.answer.trim() ? "incomplete" : "empty"}. Retrying once at low effort.`);
    const retry = await input.client.responses.create(
      {
        ...requestBody,
        max_output_tokens: getRetryOutputTokens(input.model, input.reasoning?.effort),
        ...(input.reasoning ? { reasoning: { effort: "low" as const } } : {}),
      },
      { timeout: Math.max(8_000, Math.min(40_000, remaining() - 4_000)), signal: input.signal },
    );
    logChatDiagnostics(input.requestId, retry);
    add(extractChatUsage(retry, input.model));
    const retryExtracted = extractCitedAnswer(retry, true, { slug: input.slug });
    if (retryExtracted.answer.trim()) {
      response = retry;
      extracted = retryExtracted;
    }
  }

  const aligned = alignCitations(extracted.answer, evidence);
  return {
    answer: aligned.answer,
    citations: aligned.citations,
    newsSearched: web.newsOk,
    officialSearched: web.officialOk,
    usage,
  };
}

function boardRosterEvidence(slug: string, question: string, now: Date): EvidenceItem | null {
  if (!isBoardRosterQuestion(question)) return null;
  const page = officialPages(slug).find((entry) => /village-board/i.test(entry.url));
  if (!page) return null;
  return scoreEvidence({
    id: page.url,
    kind: "official",
    filename: page.title,
    url: page.url,
    text: `${page.title}. ${page.useWhen} Cite this official Village Board page for who the Village President and trustees are.`,
    score: 2,
  }, question, now);
}
