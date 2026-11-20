import type OpenAI from "openai";
import type { ComparisonFilter, CompoundFilter } from "openai/resources/shared";

import { DEFAULT_REASONING_MODEL, type ReasoningEffort } from "@/lib/chat-model";
import { buildChatInstructions, getMaxOutputTokens, getRetryOutputTokens } from "@/lib/chat-instructions";
import { logChatDiagnostics } from "@/lib/chat-diagnostics";
import { asksAboutLegislation, recordDateNumber, dateBoostFor, calendarStamp, questionAsksAboutHistory, shiftMonths } from "@/lib/file-search";
import { excludedCitationFilename, officialPages } from "@/lib/source-links";
import { addChatUsage, estimateCostMicrousd, extractChatUsage, type ChatUsage } from "@/lib/chat-usage";
import {
  describeLegistarMatter,
  legistarClientFor,
  legistarFileNumbers,
  legistarSearchMatters,
  legistarVectorQuery,
  matterRecordStamp,
  queryLegistarMatters,
  wantsLegistarLookup,
  type LegistarMatter,
} from "@/lib/legistar";
import { extractCitedAnswer, omitEmptyMissingSection, omitInvalidCitationLines, omitTrailingCitationDump, type ChatCitation } from "@/lib/news-search";
import { turnLanguageDirective } from "@/lib/ui-locale";
import {
  officialWebDomains,
  newspaperDomainsFor,
  webPassEnabled,
  canonicalHttpsUrl,
  matchWebUrl,
  IDOT_LETTING_SOURCE,
  type WebSource,
  type WebSourceKind,
} from "@/lib/web-sources";

export const RESEARCH_QUERY_LIMIT = 12;
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

const CONSTRUCTION_QUESTION =
  /\b(?:contractors?|vendors?|awarded|who\s+(?:built|did|was\s+awarded)|construction\s+contract)\b/i;

export function asksAboutConstruction(question: string): boolean {
  return CONSTRUCTION_QUESTION.test(stripHarnessPrefix(question));
}

/** Named project when the question has one, otherwise the question with the filler words removed. */
function projectPhrase(question: string): string {
  const named = topicPhrase(question);
  if (named !== "the project") return named;
  const cleaned = stripHarnessPrefix(question)
    .replace(/[?.,;:]+/g, " ")
    .replace(/\b(?:what|whats|what's|who|when|where|why|how|did|does|do|is|are|was|were|the|a|an|board|decide|decided|about|please|tell|me|of|for|and|any|there|has|have|had|been|current|our|village)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "municipal action").slice(0, 140);
}

export type LegislativeKind = "ORD" | "RES" | "MOT";

export type LegislativeId = {
  kind: LegislativeKind;
  /** Year-serial, such as 23-118. */
  number: string;
  /** Canonical form, such as ORD 23-118. */
  canonical: string;
};

/** ORD 23-118, RES 24-12, MOT 24-142, and the dotted Ord. form. */
export function legislativeIds(text: string): LegislativeId[] {
  const found = new Map<string, LegislativeId>();
  for (const match of text.matchAll(/\b(ORD|RES|MOT)\.?\s*(\d{2})\s*-\s*(\d{2,4})\b/gi)) {
    const kind = match[1].toUpperCase() as LegislativeKind;
    const number = `${match[2]}-${match[3]}`;
    const canonical = `${kind} ${number}`;
    if (!found.has(canonical)) found.set(canonical, { kind, number, canonical });
  }
  return [...found.values()];
}

export function legislativeIdQueries(id: LegislativeId): string[] {
  const label = id.kind === "ORD" ? "Ordinance" : id.kind === "RES" ? "Resolution" : "Motion";
  const dotted = id.kind === "ORD" ? "Ord." : id.kind === "RES" ? "Res." : "Mot.";
  return [`${id.kind} ${id.number}`, `${dotted} ${id.number}`, `${label} ${id.number}`];
}

const READING_BOILERPLATE = /\b(?:first reading|second reading(?: and adoption)?|for adoption|consent agenda|agenda item)\b/gi;

function legislativeIdPattern(id: LegislativeId): RegExp {
  const label = id.kind === "ORD" ? "Ordinance" : id.kind === "RES" ? "Resolution" : "Motion";
  return new RegExp(`\\b(?:${id.kind}|${label})\\.?\\s*${id.number.replace("-", "\\s*-\\s*")}\\b`, "i");
}

/** Subject line sitting next to a legislative ID on an agenda, in the minutes, or in code history. */
export function descriptionNearLegislativeId(text: string, id: LegislativeId): string | null {
  const pattern = legislativeIdPattern(id);
  const match = pattern.exec(text);
  if (!match || match.index === undefined) return null;
  const start = Math.max(0, match.index - 120);
  const end = Math.min(text.length, match.index + match[0].length + 220);
  const cleaned = text
    .slice(start, end)
    .replace(pattern, " ")
    .replace(READING_BOILERPLATE, " ")
    .replace(/\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b/g, " ")
    .replace(/[^A-Za-z0-9'’./&-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 2 || /\d/.test(word))
    .join(" ");
  if (cleaned.length < 20) return null;
  return cleaned.slice(0, 180);
}

function dateFromNearbyText(text: string): number | undefined {
  const numeric = /\b(\d{1,2})[-/](\d{1,2})[-/]((?:19|20)\d{2})\b/.exec(text);
  if (!numeric) return undefined;
  const month = Number(numeric[1]);
  const day = Number(numeric[2]);
  const year = Number(numeric[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return year * 10_000 + month * 100 + day;
}

function shiftDays(stamp: number, days: number): number {
  const year = Math.floor(stamp / 10_000);
  const month = Math.floor((stamp % 10_000) / 100);
  const day = stamp % 100;
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

export function dateWindowAround(stamp: number, beforeDays = 60, afterDays = 45): { start: number; end: number } {
  return { start: shiftDays(stamp, -beforeDays), end: shiftDays(stamp, afterDays) };
}

function matterDateFilter(matter: LegistarMatter): CompoundFilter | undefined {
  const stamp = matterRecordStamp(matter);
  if (!stamp) return undefined;
  const window = dateWindowAround(stamp);
  return {
    type: "and",
    filters: [
      { type: "gte", key: "record_date", value: window.start },
      { type: "lte", key: "record_date", value: window.end },
    ],
  };
}

function isLegislativeIndexHit(item: EvidenceItem): boolean {
  const type = (item.documentType ?? "").toLowerCase();
  if (type === "ordinance" || type === "resolution") return false;
  if (type === "agenda" || type === "minutes") return true;
  const label = `${item.filename} ${item.title ?? ""}`;
  if (/\b(?:agenda|minutes|packet)\b/i.test(label)) return true;
  return /\b(?:amended by|village code|code history|second reading|first reading)\b/i.test(item.text);
}

export type LegislativeFollowUp = {
  id: string;
  query: string;
  recordDate?: number;
  dateStart?: number;
  dateEnd?: number;
};

/**
 * Once an agenda, minutes, or code-history passage names a legislative ID,
 * search the subject next to that ID around the meeting date. The adopted
 * document often never repeats the ID.
 */
export function legislativeResolutionQueries(items: EvidenceItem[]): LegislativeFollowUp[] {
  const records = items.filter((item) => item.kind === "record" && isLegislativeIndexHit(item));
  const out: LegislativeFollowUp[] = [];
  const seen = new Set<string>();
  for (const item of records) {
    const source = `${item.title ?? ""}\n${item.filename}\n${item.text}`;
    for (const id of legislativeIds(source)) {
      if (seen.has(id.canonical)) continue;
      const description = descriptionNearLegislativeId(source, id);
      if (!description) continue;
      seen.add(id.canonical);
      const pattern = legislativeIdPattern(id);
      const located = pattern.exec(source);
      const recordDate = (located ? dateFromNearbyText(source.slice(Math.max(0, located.index - 80), located.index + 120)) : undefined) ?? item.recordDate;
      const window = recordDate ? dateWindowAround(recordDate) : undefined;
      out.push({
        id: id.canonical,
        query: description,
        ...(recordDate ? { recordDate, dateStart: window?.start, dateEnd: window?.end } : {}),
      });
      if (out.length >= 3) return out;
    }
  }
  return out;
}

export function legislativeQueryVariants(question: string): string[] {
  if (!asksAboutLegislation(question)) return [];
  const topic = projectPhrase(question);
  return [`${topic} motion approved`, `${topic} adopted`, `${topic} resolution agenda minutes`];
}

export function contractorQueries(question: string): string[] {
  if (!asksAboutConstruction(question)) return [];
  const topic = projectPhrase(question);
  // These searches stay unfiltered. The award often lives in a budget-explanation
  // file whose document_type is ordinance or budget, not a construction contract.
  const project = /streetscape/i.test(topic) ? topic : `${topic} streetscape`;
  return [
    `${project} contract awarded IDOT bid`,
    `${topic} Section awarded to`,
    `${topic} contract awarded`,
    `${topic} construction contract awarded`,
    `${topic} construction contractor bid award`,
    `${topic} awarded to`,
    `${topic} low bidder`,
    `${topic} budget explanation`,
    `${topic} IDOT letting`,
  ];
}

/** Parts the merged evidence still does not answer, with a targeted follow-up query for each. */
export function missingPartQueries(question: string, evidenceText: string): string[] {
  const text = stripHarnessPrefix(question);
  const topic = topicPhrase(text);
  const checks: { when: RegExp; covered: RegExp; queries: string[] }[] = [
    {
      when: CONSTRUCTION_QUESTION,
      covered: /\bawarded to\s+[A-Z]|\b(?:Co\.|Inc\.|LLC|Corp\.)\b/,
      queries: contractorQueries(text),
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
  const parkingCovered = /\b(?:ordinance|motion|ORD|MOT)\b[\s\S]{0,80}\b20(?:2[3-6])\b|\b20(?:2[3-6])\b[\s\S]{0,80}\b(?:ordinance|motion|passed|adopted|expansion)\b/i;
  if (/\bovernight parking\b/i.test(text) && /\b(?:current|policy)\b/i.test(text) && !parkingCovered.test(evidenceText)) {
    checks.push({
      when: /./,
      covered: /$a/,
      queries: [
        "overnight parking ordinance adopted 2023",
        "overnight parking ordinance adopted 2024",
        "overnight parking motion approved",
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
  // File numbers already answered by a Legistar matter should not open another search wave.
  if (queries.length === 0) return [];
  return uniqueQueries([...queries, ...discoveredSearchTerms(topic, evidenceText)], 8);
}

/** Ordinance numbers and company names already in the evidence, searched again instead of guessed. */
export function discoveredSearchTerms(topic: string, evidenceText: string): string[] {
  const idQueries = legislativeIds(evidenceText).flatMap((id) => legislativeIdQueries(id));
  const companies = [...evidenceText.matchAll(/\b([A-Z][A-Za-z&'.-]+(?:\s+[A-Z][A-Za-z&'.-]+){0,3}\s(?:Co\.|Inc\.|LLC|Corp\.|Company))\b/g)].map((match) => match[1]);
  return [...idQueries, ...companies.map((name) => `${topic} ${name}`)];
}

/** Targeted file-search queries. Person, year, and multi-part coverage is kept even if the planner is vague. */
export function draftResearchQueries(question: string, now = new Date()): string[] {
  const cleaned = stripHarnessPrefix(question);
  return uniqueQueries([
    ...coreResearchQueries(cleaned, now),
    ...legislativeQueryVariants(cleaned),
    ...legislativeIds(cleaned).flatMap((id) => legislativeIdQueries(id)),
    ...contractorQueries(cleaned),
  ]);
}

function coreResearchQueries(question: string, now: Date): string[] {
  const cleaned = question;
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
  return queries;
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
  if (name && !textMentionsPerson(name, haystack)) return false;
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

const GIVEN_NAME_NICKNAMES: Record<string, string[]> = {
  robert: ["bob", "rob", "bobby", "robbie"],
  william: ["bill", "will", "billy", "liam"],
  james: ["jim", "jimmy"],
  richard: ["rick", "dick", "rich"],
  michael: ["mike"],
  thomas: ["tom", "tommy"],
  charles: ["charlie", "chuck"],
  joseph: ["joe"],
  elizabeth: ["liz", "beth", "betty"],
  katherine: ["kate", "kathy", "katie"],
  catherine: ["cathy", "kate", "katie"],
  daniel: ["dan", "danny"],
  david: ["dave"],
  anthony: ["tony"],
  christopher: ["chris"],
  stephen: ["steve"],
  steven: ["steve"],
  edward: ["ed", "eddie", "ted"],
  theodore: ["ted", "theo"],
  nicholas: ["nick"],
  benjamin: ["ben"],
  samuel: ["sam"],
  alexander: ["alex"],
  andrew: ["andy"],
  john: ["jack"],
  patricia: ["pat", "patty"],
};

/** Surname, plus a short form of the given name such as Bob for Robert. */
export function personNameVariants(name: string): string[] {
  const parts = name.toLowerCase().replace(/[.’']/g, "").split(/\s+/).filter((part) => part.length > 1 && !part.endsWith("."));
  const variants = new Set<string>();
  const surname = parts[parts.length - 1];
  const given = parts[0];
  if (surname && surname.length > 2) variants.add(surname);
  if (given && given.length > 2) {
    for (const nickname of GIVEN_NAME_NICKNAMES[given] ?? []) variants.add(nickname);
  }
  return [...variants];
}

export function textMentionsPerson(name: string, text: string): boolean {
  const haystack = normalizeOverlapText(text);
  return personNameVariants(name).some((variant) => {
    if (variant.length <= 3) return new RegExp(`\\b${variant}\\b`).test(haystack);
    return haystack.includes(variant);
  });
}

/**
 * A who-is search hit is often only the article URL. Wednesday Journal slugs
 * such as "villager-of-the-year" do not repeat the person's name.
 */
function isLinkOnlyNewspaperHit(text: string): boolean {
  if (!/https:\/\/[^\s]*?(?:oakpark\.com|chicagotribune\.com)/i.test(text)) return false;
  const withoutUrls = text.replace(/https?:\/\/\S+/gi, " ");
  // A written sentence is an article excerpt. A bare search hit is only the URL and its slug.
  if (/[A-Za-z][.!?](?:\s|$)/.test(withoutUrls)) return false;
  const words = withoutUrls
    .replace(/[^a-z0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !/^(?:www|com|http|https|oakpark|chicagotribune)$/i.test(word));
  return words.length <= 16;
}

/**
 * Newspaper evidence must overlap the question's entity or topic.
 * A named street has to appear; a shared word such as "streetscape" is not enough.
 * A person question keeps a hit only when it names that person.
 */
export function newsEvidenceIsRelevant(question: string, text: string): boolean {
  const name = personName(question);
  if (name) {
    if (textMentionsPerson(name, text)) return true;
    return isLinkOnlyNewspaperHit(text);
  }
  const entities = placeEntities(question);
  if (entities.length > 0) return entities.some((entity) => normalizeOverlapText(text).includes(entity));
  return webResultIsRelevant(question, text);
}

/**
 * IDOT letting hits are often bare result URLs. Keep a hit when it names the
 * street, the streetscape, a section award, or a letting. A URL that shares
 * none of those words is not evidence of the contractor.
 */
export function idotEvidenceIsRelevant(question: string, text: string): boolean {
  const body = text.toLowerCase();
  const places = placeEntities(question);
  const streetHit = places.some((place) => body.includes(place) || body.includes(place.split(" ")[0] ?? ""));
  const projectHit = /\bstreetscape\b/i.test(question) && /\bstreetscape\b/.test(body);
  const awardHit = /\b(?:awarded(?:\s+to)?|low bidder|lettings?|bidder)\b/i.test(text);
  const sectionHit = /\bsection\b/i.test(text) && /\b\d{2}-\d{4,}/.test(text);
  if (sectionHit && (streetHit || projectHit || awardHit)) return true;
  if ((streetHit || projectHit) && (awardHit || /\bcontract\b/.test(body))) return true;
  if (streetHit && projectHit) return true;
  return false;
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

function hasAwardLanguage(blob: string): boolean {
  if (/\b(?:awarded to|low bidder|lettings?|budget explanations?)\b/i.test(blob)) return true;
  if (/\bconstruction\s+contract\b/i.test(blob)) return true;
  return /\bawarded\b/i.test(blob) && /\b(?:contract|bidder|letting|IDOT)\b/i.test(blob);
}

function namesProject(question: string, blob: string): boolean {
  const project = projectPhrase(question).toLowerCase();
  if (project === "the project") return false;
  const haystack = blob.toLowerCase();
  if (/\bstreetscape\b/.test(project)) return /\bstreetscape\b/.test(haystack);
  const tokens = project.split(/\s+/).filter((word) => word.length > 3);
  return tokens.length > 0 && tokens.every((word) => haystack.includes(word));
}

function unrelatedProject(question: string, blob: string): boolean {
  const asked = question.toLowerCase();
  const haystack = blob.toLowerCase();
  return /\bstreetscape\b/.test(asked)
    && !/\bstreetscape\b/.test(haystack)
    && /\b(?:sewer|water ?main|drainage|sanitary)\b/.test(haystack);
}

/**
 * Prefer a construction award for the named project over a design consultant
 * or a different project on the same street. Budget-explanation files carry
 * the award when the ordinance body does not.
 */
export function constructionRankMultiplier(
  question: string,
  item: { filename: string; title?: string; text: string },
): number {
  if (!asksAboutConstruction(question)) return 1;
  const blob = `${item.filename}\n${item.title ?? ""}\n${item.text}`;
  const award = hasAwardLanguage(blob);
  const design = /\b(?:design|engineering|consultant|architectural)\b/i.test(blob);
  let multiplier = 1;
  if (design && !award) multiplier *= 0.45;
  if (award && namesProject(question, blob)) multiplier *= 1.9;
  else if (award) multiplier *= 1.25;
  if (/bud(?:get)?[_ ./-]*explanations?/i.test(`${item.filename} ${item.title ?? ""}`)) multiplier *= 1.4;
  if (unrelatedProject(question, blob)) multiplier *= 0.4;
  return multiplier;
}

export function scoreEvidence(item: Omit<EvidenceItem, "tier" | "rankScore">, question: string, now = new Date()): EvidenceItem {
  const tier: 0 | 1 = item.kind === "newspaper" ? 1 : 0;
  const boost = dateBoostFor(item.recordDate, calendarStamp(now), questionAsksAboutHistory(question));
  let rankScore = item.score * boost * (item.kind === "record" ? typeBoost(item.documentType) : 1);
  if (isBoardRosterQuestion(question) && /village-board/i.test(item.url ?? "")) rankScore += 5;
  if (item.documentType === "legistar") rankScore += 1.5;
  if (item.kind === "newspaper") {
    const named = personName(question);
    if (named && textMentionsPerson(named, `${item.filename}\n${item.title ?? ""}\n${item.text}`)) rankScore += 3;
    if (/\b(?:budget|spending|levy|fund|reserves?)\b/i.test(question)) {
      if (/\breserves?\b/i.test(item.text)) rankScore += 3;
      if (/\$\s?\d/.test(item.text)) rankScore += 2;
    }
  }
  rankScore *= constructionRankMultiplier(question, item);
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
      guidance.push(`This question asks who ${name} is. Newspaper coverage is required. You must use every newspaper result that mentions ${name} (${markers}), including a last-name or nickname such as Bob. State what that reporting says about ${name}, including an award or office named in the headline, label it as reporting, and cite each of those numbers.`);
    }
  }
  if (/\b(?:budget|spending|levy|fund|reserves?)\b/i.test(question)) {
    const money = news.filter((item) => /\breserves?\b|\$\s?\d/i.test(`${item.title ?? ""}\n${item.text}`));
    if (money.length > 0) {
      const markers = money.map((item) => `[${items.indexOf(item) + 1}]`).join(", ");
      guidance.push(`Newspaper findings ${markers} report a budget figure or a reserve draw that answers this question. State that finding, including the amount when one is given, and cite the marker. Do not leave it out of the answer in favor of the official records alone.`);
    }
  }
  if (isBoardRosterQuestion(question)) {
    guidance.push("When the question asks who the Village President or trustees are, cite the official Village Board page.");
  }
  if (/\bovernight parking\b/i.test(question) && /\b(?:current|policy|rules?)\b/i.test(question)) {
    guidance.push("For the current overnight parking policy, include 2023 and 2024 ordinance or Legistar changes that appear in the evidence, not only the current website summary.");
  }
  if (items.some((item) => item.documentType === "legistar")) {
    guidance.push("A Legistar matter with status Passed or Adopted was adopted on its passed date. A First Reading is a proposal, not an adoption. When both appear, state the proposal and the later adoption separately. When you use a Legistar matter, write its file number, such as ORD 23-118 or MOT 24-142, in the sentence. Do not leave the file number only in the citation title.");
  }
  if (asksAboutConstruction(question)) {
    guidance.push("For a contractor or vendor, prefer the passage that states the construction award, low bidder, or letting for the named project, including a budget-explanation document. Do not substitute a design or engineering consultant, or a different project on the same street.");
  }
  return [guidance.join(" "), ...lines].join("\n\n");
}

/**
 * Renumber inline [n] markers to match the returned citation list, in the order
 * they first appear. Every returned citation, including a record, gets that marker.
 * Stock newspaper lines with an empty or markdown body are removed first.
 */
function citationIdentity(item: EvidenceItem): string {
  if (item.kind === "record") {
    const name = item.filename.trim().toLowerCase();
    return name ? `record:${name}` : `record:${item.id}`;
  }
  return `${item.kind}:${citationUrl(item) ?? item.url ?? item.id}`;
}

/**
 * Renumber inline [n] markers to the sources the answer actually uses.
 * Passages from the same file share one citation. A trailing dump of markers
 * and an empty "What I couldn't find." heading are removed first.
 */
export function alignCitations(answer: string, items: EvidenceItem[]): { answer: string; citations: ChatCitation[] } {
  const cleaned = omitEmptyMissingSection(omitTrailingCitationDump(omitInvalidCitationLines(answer)));
  const mentioned: number[] = [];
  const seen = new Set<number>();
  for (const match of cleaned.matchAll(/\[(\d+)\]/g)) {
    const number = Number(match[1]);
    if (number < 1 || number > items.length || seen.has(number)) continue;
    seen.add(number);
    mentioned.push(number);
  }
  const identityNumber = new Map<string, number>();
  const oldToNew = new Map<number, number>();
  const citations: ChatCitation[] = [];
  for (const old of mentioned) {
    const item = items[old - 1];
    const identity = citationIdentity(item);
    let next = identityNumber.get(identity);
    if (!next) {
      next = citations.length + 1;
      identityNumber.set(identity, next);
      citations.push(citationForItem(item, next));
    }
    oldToNew.set(old, next);
  }
  const rewritten = cleaned
    .replace(/\[(\d+)\]/g, (full, raw: string) => {
      const next = oldToNew.get(Number(raw));
      return next ? `[${next}]` : "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { answer: rewritten, citations };
}

function citationUrl(item: EvidenceItem): string | undefined {
  const candidate = item.url || (item.id.startsWith("https://") ? item.id : "");
  if (!candidate) return undefined;
  return matchWebUrl(candidate)?.url ?? matchWebUrl(candidate, [IDOT_LETTING_SOURCE])?.url;
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
    filters?: ComparisonFilter | CompoundFilter;
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

function decodedUrlPath(url: string): string {
  try { return decodeURIComponent(url).replace(/[-_/]+/g, " "); } catch { return url; }
}

function isIdotHost(url: string): boolean {
  try { return /(^|\.)dot\.illinois\.gov$/i.test(new URL(url).hostname); } catch { return false; }
}

function nearbyText(text: string, url: string): string {
  const at = text.indexOf(url);
  if (at < 0) return "";
  return text.slice(Math.max(0, at - 500), Math.min(text.length, at + url.length + 500));
}

function webItemsFromResponse(
  response: OpenAI.Responses.Response,
  question: string,
  now: Date,
  fallbackKind: WebSourceKind,
  sources?: WebSource[],
): { items: EvidenceItem[]; dropped: number; hosts: string[] } {
  const items: EvidenceItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  const hosts: string[] = [];
  const passages: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type === "output_text" && content.text.trim()) passages.push(content.text.trim());
    }
  }
  const fullText = passages.join("\n\n");
  const add = (url: string, title: string, excerpt: string) => {
    const matched = sources ? matchWebUrl(url, sources) : matchWebUrl(url);
    let host = "";
    try { host = new URL(url).hostname; } catch { host = url.slice(0, 40); }
    if (!hosts.includes(host)) hosts.push(host);
    const path = decodedUrlPath(url);
    const around = nearbyText(fullText, url);
    const body = `${title}\n${excerpt}\n${path}\n${around}`;
    const idot = Boolean(matched && (isIdotHost(matched.url) || isIdotHost(url)));
    const relevant = !matched ? false
      : idot ? idotEvidenceIsRelevant(question, body)
      : matched.kind === "newspaper" ? newsEvidenceIsRelevant(question, body)
      : webResultIsRelevant(question, body);
    if (!matched || !relevant) {
      dropped += 1;
      return;
    }
    if (seen.has(matched.url)) return;
    seen.add(matched.url);
    const quote = excerpt.startsWith("http") ? `${title}\n${path}`.trim() : excerpt;
    items.push(scoreEvidence({
      id: matched.url,
      kind: matched.kind,
      filename: title || matched.label,
      title: title || undefined,
      url: matched.url,
      text: (quote || path).slice(0, 900),
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
      for (const url of urlsInText(text)) add(url, "", nearbyText(text, url) || text.slice(0, 900));
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
    sources?: WebSource[];
    timeoutMs?: number;
    retry?: boolean;
    instructions?: string;
  },
): Promise<WebPassResult> {
  const domains = input.domains ?? (input.kind === "official" ? officialWebDomains(input.slug) : newspaperDomainsFor(input.slug));
  if (domains.length === 0) return { items: [], usage: null, ok: false };
  const timeoutMs = input.timeoutMs ?? WEB_TIMEOUT_MS;
  const attempt = async () => {
    const response = await client.responses.create(
      {
        model: process.env.MUNIGPT_PLANNER_MODEL?.trim() || DEFAULT_REASONING_MODEL,
        reasoning: { effort: "none" },
        max_output_tokens: 6_000,
        tool_choice: "required",
        instructions: input.instructions ?? (input.kind === "official"
          ? "Search only the allowed official municipal site. Quote short passages that are about the question, with page titles and full https URLs. Skip unrelated pages. Do not write the final answer. Do not conclude that a person was not an official."
          : "Search only the allowed newspapers, including www.oakpark.com for the Wednesday Journal. Quote short passages that are about the question, with the article title, date, and full https URL. Skip unrelated articles. Call each passage newspaper reporting. Do not write the final answer."),
        input: webQuery(input.question, input.kind, input.focus),
        include: ["web_search_call.action.sources"],
        tools: [{
          type: "web_search",
          filters: { allowed_domains: domains },
          external_web_access: true,
          search_context_size: "low",
        }],
      },
      { timeout: timeoutMs, signal: input.signal },
    );
    logChatDiagnostics(input.requestId, response);
    const extracted = webItemsFromResponse(response, input.question, input.now, input.kind, input.sources);
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
    if (input.retry === false) {
      console.info(`[${input.requestId}] ${input.kind} web search timed out after ${timeoutMs}ms.`);
      return { items: [], usage: null, ok: false };
    }
    console.info(`[${input.requestId}] ${input.kind} web search timed out after ${timeoutMs}ms. Retrying once.`);
    try {
      return await attempt();
    } catch (retryError) {
      if (input.signal?.aborted) throw retryError;
      console.error(`[${input.requestId}] ${input.kind} web search retry failed.`, retryError);
      return { items: [], usage: null, ok: false };
    }
  }
}

export const RESEARCH_PLANNER_INSTRUCTIONS =
  'Return JSON only: {"queries":["..."]}. Write 3 to 6 short file-search queries. One query per part of the question. For a span of years, one query per year. For a person, include the name with trustee, village board, roll call, budget, and president. When the question is about an ordinance, law, rule, resolution, motion, policy, or an adopted change, also query the motion, the resolution, and the agenda or minutes, using the words motion, approved, and adopted. A legislative ID (ORD, RES, or MOT plus a number, including an Ord. form) is often only on an agenda, in the minutes, or in code history, so search that ID and the subject described next to it. When the question asks who built the work, who was awarded it, or names a contractor or vendor, query the construction contract award, budget explanations, and the letting, and do not stop at a design or engineering consultant. Do not answer the question.';

async function planQueries(
  client: OpenAI,
  input: { question: string; signal?: AbortSignal; requestId: string },
): Promise<{ queries: string[]; usage: ChatUsage | null }> {
  const response = await client.responses.create(
    {
      model: process.env.MUNIGPT_PLANNER_MODEL?.trim() || DEFAULT_REASONING_MODEL,
      reasoning: { effort: "none" },
      max_output_tokens: 4_000,
      instructions: RESEARCH_PLANNER_INSTRUCTIONS,
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
  const legistarClient = legistarClientFor(input.slug);
  const legistarOn = Boolean(legistarClient) && wantsLegistarLookup(question);
  const runIdot = webOn && asksAboutConstruction(question);
  if (runOfficial || runNews || legistarOn) input.onProgress?.("Searching the village website and newspapers…");

  const emptyWeb = Promise.resolve({ items: [] as EvidenceItem[], usage: null, ok: false });
  const webPromise = (async () => {
    if (!webOn) return { items: [] as EvidenceItem[], officialOk: false, newsOk: false };
    const passes = await Promise.all([
      runOfficial ? runWebPass(input.client, { ...input, question, kind: "official", now }) : emptyWeb,
      runNews ? runWebPass(input.client, { ...input, question, kind: "newspaper", now }) : emptyWeb,
      runIdot ? runWebPass(input.client, {
        ...input,
        question,
        kind: "official",
        now,
        domains: [IDOT_LETTING_SOURCE.domain],
        sources: [IDOT_LETTING_SOURCE],
        focus: `${projectPhrase(question)} construction contract awarded low bidder letting`,
        timeoutMs: 8_000,
        retry: false,
        instructions: "Search only the allowed IDOT letting site. Quote the construction contract award, the low bidder, the letting number, and the amount for the named project. Skip design contracts and unrelated projects. Do not write the final answer.",
      }) : emptyWeb,
    ]);
    for (const pass of passes) add(pass.usage);
    return {
      items: passes.flatMap((pass) => pass.items),
      officialOk: passes[0].ok || passes[2].ok,
      newsOk: passes[1].ok,
    };
  })();

  const searchMatter = (matter: LegistarMatter) => {
    const filters = matterDateFilter(matter);
    return searchRecords(input.client, {
      vectorStoreIds: input.vectorStoreIds,
      query: legistarVectorQuery(matter),
      ...(filters ? { filters } : {}),
      question,
      now,
      signal: input.signal,
    }).catch((error: unknown) => {
      if (isAbort(error) && input.signal?.aborted) throw error;
      console.error(`[${input.requestId}] Legistar record search failed.`, error);
      return [] as EvidenceItem[];
    });
  };

  const legistarItem = (matter: LegistarMatter): EvidenceItem => scoreEvidence({
    id: matter.url,
    kind: "official",
    filename: `${matter.file}: ${matter.title}`.slice(0, 140),
    title: matter.title,
    url: matter.url,
    text: describeLegistarMatter(matter),
    recordDate: matterRecordStamp(matter),
    documentType: "legistar",
    score: 2.6,
  }, question, now);

  // The API call and the date-bounded record search overlap the planner and the first record wave.
  const legistarPromise = (async () => {
    if (!legistarOn || !legistarClient) return { matters: [] as LegistarMatter[], items: [] as EvidenceItem[], calls: 0 };
    let matters: LegistarMatter[] = [];
    try {
      matters = await queryLegistarMatters({
        clientName: legistarClient,
        question,
        now,
        signal: input.signal,
      });
    } catch (error) {
      if (isAbort(error) && input.signal?.aborted) throw error;
      console.error(`[${input.requestId}] Legistar lookup failed.`, error);
    }
    console.info(`[${input.requestId}] legistar ${matters.map((matter) => matter.file).join(", ") || "none"}`);
    const picked = legistarSearchMatters(question, matters);
    const groups = await Promise.all(picked.map((matter) => searchMatter(matter)));
    return { matters, items: groups.flat(), calls: picked.length };
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
  const recordPromise = Promise.all([
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
  const [recordGroups, web, legistar] = await Promise.all([recordPromise, webPromise, legistarPromise]);
  const boardPage = boardRosterEvidence(input.slug, question, now);
  let evidence = mergeEvidence([
    ...recordGroups.flat(),
    ...web.items,
    ...legistar.matters.map(legistarItem),
    ...legistar.items,
    ...(boardPage ? [boardPage] : []),
  ]);
  const knownFiles = new Set(legistar.matters.map((matter) => matter.file.toUpperCase()));
  let followUpCalls = 0;
  if (legistarClient) {
    const mentioned = legistarFileNumbers(evidence.map((item) => `${item.filename}\n${item.title ?? ""}\n${item.text}`).join("\n"))
      .filter((file) => !knownFiles.has(file.toUpperCase()))
      .slice(0, 3);
    if (mentioned.length > 0 && remaining() > 12_000) {
      try {
        const extraMatters = await queryLegistarMatters({
          clientName: legistarClient,
          question,
          now,
          signal: input.signal,
          onlyFiles: mentioned,
        });
        const fresh = extraMatters.filter((matter) => !knownFiles.has(matter.file.toUpperCase()));
        if (fresh.length > 0) {
          console.info(`[${input.requestId}] legistar files ${fresh.map((matter) => matter.file).join(", ")}`);
          const groups = await Promise.all(fresh.slice(0, 2).map((matter) => searchMatter(matter)));
          followUpCalls += Math.min(fresh.length, 2);
          for (const matter of fresh) knownFiles.add(matter.file.toUpperCase());
          evidence = mergeEvidence([...evidence, ...fresh.map(legistarItem), ...groups.flat()]);
        }
      } catch (error) {
        if (isAbort(error) && input.signal?.aborted) throw error;
        console.error(`[${input.requestId}] Legistar file lookup failed.`, error);
      }
    }
  }
  const gatheredText = evidence.map((item) => item.text).join("\n");
  const gaps = missingPartQueries(question, gatheredText);
  const idFollowUps = legislativeResolutionQueries(evidence).filter((item) => !knownFiles.has(item.id.toUpperCase()));
  if ((gaps.length > 0 || idFollowUps.length > 0) && remaining() > 20_000) {
    input.onProgress?.("Searching for the missing part…");
    console.info(`[${input.requestId}] follow-up searches ${JSON.stringify([...gaps, ...idFollowUps.map((item) => item.query)])}`);
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
    const descriptions = idFollowUps.map((item) => item.query);
    const descriptionGroups = await Promise.all(descriptions.map((query) => searchRecords(input.client, {
      vectorStoreIds: input.vectorStoreIds,
      query,
      question,
      now,
      signal: input.signal,
    }).catch((error: unknown) => {
      if (isAbort(error) && input.signal?.aborted) throw error;
      console.error(`[${input.requestId}] Legislative follow-up failed.`, error);
      return [] as EvidenceItem[];
    })));
    const dated = idFollowUps.filter((item): item is LegislativeFollowUp & { dateStart: number; dateEnd: number } =>
      item.dateStart !== undefined && item.dateEnd !== undefined).slice(0, 3);
    const datedGroups = await Promise.all(dated.map((item) => searchRecords(input.client, {
      vectorStoreIds: input.vectorStoreIds,
      query: item.query,
      filters: {
        type: "and",
        filters: [
          { type: "gte", key: "record_date", value: item.dateStart },
          { type: "lte", key: "record_date", value: item.dateEnd },
        ],
      },
      question,
      now,
      signal: input.signal,
    }).catch((error: unknown) => {
      if (isAbort(error) && input.signal?.aborted) throw error;
      console.error(`[${input.requestId}] Legislative follow-up failed.`, error);
      return [] as EvidenceItem[];
    })));
    followUpCalls += extra.length + descriptionGroups.length + datedGroups.length;
    evidence = mergeEvidence([...evidence, ...extra.flat(), ...descriptionGroups.flat(), ...datedGroups.flat()]);
    if (webOn && gaps.length > 0 && runNews && remaining() > 25_000) {
      const focus = gaps.slice(0, 3).join(". ");
      const extraNews = await runWebPass(input.client, { ...input, question, kind: "newspaper", now, focus });
      add(extraNews.usage);
      if (extraNews.ok) web.newsOk = true;
      evidence = mergeEvidence([...evidence, ...extraNews.items]);
    }
  }
  usage = {
    ...usage,
    fileSearchCalls: usage.fileSearchCalls + (recordGroups.length + legistar.calls + followUpCalls) * Math.max(1, input.vectorStoreIds.length),
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
