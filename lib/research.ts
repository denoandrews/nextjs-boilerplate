import type OpenAI from "openai";
import type { ComparisonFilter } from "openai/resources/shared";

import { DEFAULT_REASONING_MODEL, type ReasoningEffort } from "@/lib/chat-model";
import { buildChatInstructions, getMaxOutputTokens, getRetryOutputTokens } from "@/lib/chat-instructions";
import { logChatDiagnostics } from "@/lib/chat-diagnostics";
import { recordDateNumber, dateBoostFor, calendarStamp, questionAsksAboutHistory, shiftMonths } from "@/lib/file-search";
import { excludedCitationFilename } from "@/lib/source-links";
import { addChatUsage, estimateCostMicrousd, extractChatUsage, type ChatUsage } from "@/lib/chat-usage";
import { extractCitedAnswer, type ChatCitation } from "@/lib/news-search";
import { turnLanguageDirective } from "@/lib/ui-locale";
import {
  officialWebDomains,
  newspaperDomainsFor,
  webPassEnabled,
  matchWebUrl,
  type WebSourceKind,
} from "@/lib/web-sources";

export const RESEARCH_QUERY_LIMIT = 6;
export const RESEARCH_OFFICIAL_SLOTS = 30;
export const RESEARCH_NEWSPAPER_SLOTS = 6;
const SEARCH_RESULTS = 12;
const PLAN_TIMEOUT_MS = 12_000;
const SEARCH_TIMEOUT_MS = 10_000;
const WEB_TIMEOUT_MS = 18_000;
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

export function personName(question: string): string | null {
  const match = question.match(/\b(?:[Ww]ho|[Qq]ui[eé]n)\s+(?:is|was|es|fue)\s+((?:[A-Z][a-z]+|[A-Z]\.)(?:\s+(?:[A-Z][a-z]+|[A-Z]\.)){0,3})/);
  if (!match) return null;
  const name = match[1].replace(/[?.!,;:]+$/g, "").trim();
  if (/^(?:the|village|board|mayor|president)\b/i.test(name)) return null;
  return name;
}

function uniqueQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const query of queries) {
    const trimmed = query.replace(/\s+/g, " ").trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length < 3 || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed.slice(0, 180));
    if (out.length >= RESEARCH_QUERY_LIMIT) break;
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

/** Targeted file-search queries. Person, year, and multi-part coverage is kept even if the planner is vague. */
export function draftResearchQueries(question: string, now = new Date()): string[] {
  const name = personName(question);
  if (name) {
    return uniqueQueries([
      `${name} trustee`,
      `${name} village board`,
      `${name} roll call`,
      `${name} budget`,
      `${name} president`,
    ]);
  }

  if (/\bovernight parking\b/i.test(question) || (/\bparking\b/i.test(question) && /\b(?:policy|permit|ordinance)\b/i.test(question))) {
    return uniqueQueries([
      "overnight parking permit ordinance 2023",
      "overnight parking permit ordinance 2024",
      "overnight parking policy minutes decision",
      question,
    ]);
  }

  if (/\blake street\b/i.test(question)) {
    const queries = ["Lake Street streetscape board decision"];
    if (/\b(?:cost|how much|budget|amount)\b/i.test(question)) queries.push("Lake Street streetscape cost contract amount");
    if (/\bcontractor\b/i.test(question)) queries.push("Lake Street streetscape construction contractor");
    if (/\bchange orders?\b/i.test(question)) queries.push("Lake Street streetscape change order");
    return uniqueQueries(queries);
  }

  const years = yearsFor(question, now);
  if (years.length >= 2 && /\b(?:budget|spending|levy|fund)\b/i.test(question)) {
    return uniqueQueries([
      ...years.map((year) => `village budget FY${year} adopted expenditures`),
      "reasons for village budget changes",
    ]);
  }

  const parts = question
    .replace(/^\s*\[TEST\]\s*/i, "")
    .split(/[?;]|\s+\band\s+|,(?=\s)/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 12);
  const queries = parts.length >= 2 ? parts : [question, `${question} minutes`, `${question} ordinance`];
  return uniqueQueries(queries);
}

export function mergeResearchQueries(required: string[], planned: string[]): string[] {
  return uniqueQueries([...required, ...planned]);
}

export function recencyCutoff(question: string, now = new Date()): number | null {
  if (questionAsksAboutHistory(question) || personName(question)) return null;
  const threeYears = /\b(?:last|past)\s+three\b|\bthree\s+(?:fiscal\s+)?years\b/i.test(question);
  const current = /\b(?:current|status|latest|recent|policy|today)\b/i.test(question);
  if (!threeYears && !current) return null;
  return shiftMonths(calendarStamp(now), threeYears ? 36 : 24);
}

export function significantTerms(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
}

/** Drops website and newspaper hits that do not share the question's topic, including a person's name. */
export function webResultIsRelevant(question: string, text: string): boolean {
  const haystack = text.toLowerCase();
  const name = personName(question);
  if (name) {
    const parts = name.toLowerCase().split(/\s+/).filter((part) => part.length > 2);
    if (parts.length > 0 && !parts.every((part) => haystack.includes(part))) return false;
  }
  const terms = significantTerms(question);
  if (terms.length === 0) return haystack.trim().length > 40;
  const hits = terms.filter((term) => haystack.includes(term));
  const needed = terms.length <= 2 ? 1 : 2;
  return hits.length >= needed;
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
  const rankScore = item.score * boost * (item.kind === "record" ? typeBoost(item.documentType) : 1);
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

export function formatEvidence(items: EvidenceItem[]): string {
  if (items.length === 0) return "No municipal records, official website pages, or newspaper passages were retrieved for this question.";
  const lines = items.map((item, index) => {
    const source = item.kind === "newspaper" ? "newspaper reporting" : item.kind === "official" ? "official website" : "municipal record";
    const date = item.recordDate ? ` | record_date: ${item.recordDate}` : "";
    const type = item.documentType ? ` | document_type: ${item.documentType}` : "";
    const url = item.url ? ` | url: ${item.url}` : "";
    return `[${index + 1}] source: ${source} | filename: ${item.filename}${date}${type}${url}\n${item.text}`;
  });
  return [
    "Evidence for this question, already merged. Municipal records and official website pages are listed before newspaper reporting. Official website content is not newspaper reporting. Use only this evidence for facts. Cite the bracket number, such as [1], at the end of every factual sentence. If a person appears only as a candidate or an objector here, say the records may be incomplete and do not conclude they were not a village official.",
    ...lines,
  ].join("\n\n");
}

export function citationsFromEvidence(answer: string, items: EvidenceItem[]): ChatCitation[] {
  const cited = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) {
    const number = Number(match[1]);
    if (number >= 1 && number <= items.length) cited.add(number);
  }
  items.forEach((item, index) => {
    if (item.url && answer.includes(item.url)) cited.add(index + 1);
    if (item.filename.length > 12 && answer.includes(item.filename)) cited.add(index + 1);
  });
  return [...cited].sort((left, right) => left - right).map((number) => {
    const item = items[number - 1];
    const official = item.kind === "official";
    const newspaper = item.kind === "newspaper";
    return {
      fileId: item.id,
      filename: item.filename,
      ...(item.url ? { url: item.url } : {}),
      ...(official ? { marker: `[Official ${number}]` } : {}),
      ...(newspaper ? { marker: `[News ${number}]` } : {}),
    };
  });
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

function webItemsFromResponse(response: OpenAI.Responses.Response, question: string, now: Date, fallbackKind: WebSourceKind): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type !== "output_text") continue;
      const text = content.text.trim();
      const annotations = content.annotations.filter((annotation) => annotation.type === "url_citation");
      if (annotations.length === 0) {
        if (webResultIsRelevant(question, text)) {
          items.push(scoreEvidence({
            id: `web-text:${fallbackKind}:${text.slice(0, 80)}`,
            kind: fallbackKind,
            filename: fallbackKind === "official" ? "Official website" : "Newspaper",
            text: text.slice(0, 900),
            score: overlapScore(question, text),
          }, question, now));
        }
        continue;
      }
      for (const annotation of annotations) {
        if (annotation.type !== "url_citation") continue;
        const matched = matchWebUrl(annotation.url);
        if (!matched) continue;
        const start = Math.max(0, annotation.start_index - 500);
        const excerpt = text.slice(start, Math.max(annotation.end_index, start + 200)).trim() || text.slice(0, 900);
        const body = `${annotation.title ?? ""}\n${excerpt}`;
        if (!webResultIsRelevant(question, body)) continue;
        items.push(scoreEvidence({
          id: matched.url,
          kind: matched.kind,
          filename: annotation.title || matched.label,
          title: annotation.title || undefined,
          url: matched.url,
          text: excerpt.slice(0, 900),
          score: overlapScore(question, body),
        }, question, now));
      }
    }
  }
  return items;
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
  },
): Promise<{ items: EvidenceItem[]; usage: ChatUsage | null }> {
  const domains = input.kind === "official" ? officialWebDomains(input.slug) : newspaperDomainsFor(input.slug);
  if (domains.length === 0) return { items: [], usage: null };
  const name = personName(input.question);
  const query = name
    ? `${input.question}\nLook up ${name}, including trustee, village board, roll call, budget, and president.`
    : input.question;
  const response = await client.responses.create(
    {
      model: process.env.MUNIGPT_PLANNER_MODEL?.trim() || DEFAULT_REASONING_MODEL,
      reasoning: { effort: "low" },
      max_output_tokens: 1_200,
      tool_choice: "required",
      instructions: input.kind === "official"
        ? "Search only the official municipal website. Quote short passages that are about the question, with page titles and URLs. Skip unrelated pages. Do not write the final answer. Do not conclude that a person was not an official."
        : "Search only the approved newspapers. Quote short passages that are about the question, with the article title, date, and URL. Skip unrelated articles. Call each passage newspaper reporting. Do not write the final answer.",
      input: query,
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
  return { items: webItemsFromResponse(response, input.question, input.now, input.kind), usage: extractChatUsage(response, DEFAULT_REASONING_MODEL) };
}

async function planQueries(
  client: OpenAI,
  input: { question: string; signal?: AbortSignal; requestId: string },
): Promise<{ queries: string[]; usage: ChatUsage | null }> {
  const response = await client.responses.create(
    {
      model: process.env.MUNIGPT_PLANNER_MODEL?.trim() || DEFAULT_REASONING_MODEL,
      reasoning: { effort: "low" },
      max_output_tokens: 500,
      instructions: 'Return JSON only: {"queries":["..."]}. Write 3 to 6 short file-search queries. One query per part of the question. For a span of years, one query per year. For a person, include the name with trustee, village board, roll call, budget, and president. Do not answer the question.',
      input: input.question,
    },
    { timeout: PLAN_TIMEOUT_MS, signal: input.signal },
  );
  logChatDiagnostics(input.requestId, response);
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
  const now = input.now ?? new Date();
  const started = Date.now();
  const remaining = () => TURN_BUDGET_MS - (Date.now() - started);
  let usage = emptyUsage(input.model);
  const add = (next: ChatUsage | null) => {
    if (next) usage = addChatUsage(usage, next, input.model);
  };

  const webOn = webPassEnabled(input.slug);
  const officialSearched = webOn && officialWebDomains(input.slug).length > 0;
  const newsSearched = webOn && newspaperDomainsFor(input.slug).length > 0;
  if (officialSearched || newsSearched) {
    input.onProgress?.("Searching the village website and newspapers…");
  }

  const webPromise = (async () => {
    if (!webOn) return [] as EvidenceItem[];
    const passes = await Promise.all([
      officialSearched ? runWebPass(input.client, { ...input, kind: "official", now }).catch((error: unknown) => {
        if (isAbort(error)) throw error;
        console.error(`[${input.requestId}] Official website search failed.`, error);
        return { items: [], usage: null };
      }) : Promise.resolve({ items: [], usage: null }),
      newsSearched ? runWebPass(input.client, { ...input, kind: "newspaper", now }).catch((error: unknown) => {
        if (isAbort(error)) throw error;
        console.error(`[${input.requestId}] Newspaper search failed.`, error);
        return { items: [], usage: null };
      }) : Promise.resolve({ items: [], usage: null }),
    ]);
    for (const pass of passes) add(pass.usage);
    return passes.flatMap((pass) => pass.items);
  })();

  input.onProgress?.("Planning record searches…");
  let planned: string[] = [];
  try {
    const plan = await planQueries(input.client, input);
    planned = plan.queries;
    add(plan.usage);
  } catch (error) {
    if (isAbort(error)) throw error;
    console.error(`[${input.requestId}] Research planner failed.`, error);
  }
  const queries = mergeResearchQueries(draftResearchQueries(input.question, now), planned);
  const cutoff = recencyCutoff(input.question, now);

  input.onProgress?.("Searching municipal records…");
  const recordGroups = await Promise.all([
    ...queries.map((query) => searchRecords(input.client, {
      vectorStoreIds: input.vectorStoreIds,
      query,
      question: input.question,
      now,
      signal: input.signal,
    }).catch((error: unknown) => {
      if (isAbort(error)) throw error;
      console.error(`[${input.requestId}] Record search failed.`, error);
      return [] as EvidenceItem[];
    })),
    ...(cutoff ? [searchRecords(input.client, {
      vectorStoreIds: input.vectorStoreIds,
      query: input.question,
      filters: { type: "gte", key: "record_date", value: cutoff },
      question: input.question,
      now,
      signal: input.signal,
    }).catch((error: unknown) => {
      if (isAbort(error)) throw error;
      console.error(`[${input.requestId}] Recent-record search failed.`, error);
      return [] as EvidenceItem[];
    })] : []),
  ]);
  const webItems = await webPromise;
  const evidence = mergeEvidence([...recordGroups.flat(), ...webItems]);
  usage = {
    ...usage,
    fileSearchCalls: usage.fileSearchCalls + recordGroups.length * Math.max(1, input.vectorStoreIds.length),
  };
  usage = { ...usage, estimatedCostMicrousd: estimateCostMicrousd(usage, input.model) };

  input.onProgress?.("Writing the answer…");
  const evidenceText = formatEvidence(evidence);
  const instructions = buildChatInstructions({
    municipalityName: input.municipalityName,
    slug: input.slug,
    newsEnabled: true,
    now,
    question: input.question,
    researchMode: true,
  });
  const requestBody = {
    model: input.model,
    max_output_tokens: getMaxOutputTokens(input.model, input.reasoning?.effort),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    instructions,
    input: [
      ...input.history,
      { role: "developer" as const, content: turnLanguageDirective(input.question) },
      { role: "developer" as const, content: evidenceText },
      { role: "user" as const, content: input.question },
    ],
  };
  const timeout = Math.max(8_000, Math.min(110_000, remaining() - 8_000));
  let response = await input.client.responses.create(requestBody, { timeout, signal: input.signal });
  logChatDiagnostics(input.requestId, response);
  add(extractChatUsage(response, input.model));
  let extracted = extractCitedAnswer(response, true, { slug: input.slug });
  if (!extracted.answer.trim() && remaining() > 12_000) {
    console.info(`[${input.requestId}] Research answer was empty. Retrying once at low effort.`);
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

  const evidenceCitations = citationsFromEvidence(extracted.answer, evidence);
  const citations = [...extracted.citations];
  for (const citation of evidenceCitations) {
    if (!citations.some((existing) => existing.fileId === citation.fileId)) citations.push(citation);
  }
  return {
    answer: extracted.answer,
    citations,
    newsSearched,
    officialSearched,
    usage,
  };
}
