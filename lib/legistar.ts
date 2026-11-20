/**
 * Direct Legistar lookups for legislative questions.
 *
 * Oak Park's public API is https://webapi.legistar.com/v1/oak-park/matters.
 * A matter record is the authority for file number, type, status, and dates.
 * The adopted ordinance text often never repeats the file number, so the
 * matter title and passed date are what a later record search should use.
 */

import { asksAboutLegislation, calendarStamp, questionAsksAboutHistory, shiftMonths } from "@/lib/file-search";

const LEGISTAR_API = "https://webapi.legistar.com/v1";
const LEGISTAR_TIMEOUT_MS = 4_500;
const SELECT_FIELDS = "MatterId,MatterGuid,MatterFile,MatterTitle,MatterTypeName,MatterStatusName,MatterIntroDate,MatterPassedDate,MatterAgendaDate,MatterBodyName";

const CLIENTS: Record<string, string> = {
  "oak-park-il": "oak-park",
};

const BOILERPLATE = new Set([
  "about", "adopt", "adopted", "adoption", "after", "also", "and", "approved", "are", "before",
  "board", "been", "but", "council", "current", "decide", "decided", "did", "does", "for", "from",
  "have", "has", "how", "into", "its", "last", "latest", "motion", "motions", "not", "oak",
  "ordinance", "ordinances", "over", "park", "passed", "please", "policies", "policy", "recent",
  "resolution", "resolutions", "rule", "rules", "status", "tell", "that", "the", "this", "today",
  "trustees", "village", "was", "were", "what", "when", "where", "which", "who", "why", "with",
  "your",
]);

const PLACE_LEADING = new Set(["the", "a", "an", "of", "on", "for", "to", "at", "along"]);
const GENERIC_PLACE = new Set(["street", "avenue", "road", "boulevard", "drive", "lane", "place", "court"]);

const FILE_ID = /\b(ORD|RES|MOT)\.?\s*(\d{2})\s*-\s*(\d{2,4})\b/gi;

export type LegistarMatter = {
  id: number;
  guid: string;
  /** Canonical file number, such as ORD 23-118. */
  file: string;
  title: string;
  typeName: string;
  statusName: string;
  introDate?: string;
  passedDate?: string;
  agendaDate?: string;
  bodyName?: string;
  url: string;
};

export function legistarClientFor(slug: string): string | null {
  return CLIENTS[slug] ?? null;
}

function cleanQuestion(text: string): string {
  return text.replace(/^(?:\s*\[(?:TEST|DEBUG|EVAL)\]\s*)+/i, "").trim();
}

/** ORD 23-118, MOT 24-142, and the dotted Ord. form, as Legistar stores MatterFile. */
export function legistarFileNumbers(text: string): string[] {
  const found = new Map<string, string>();
  for (const match of cleanQuestion(text).matchAll(FILE_ID)) {
    const file = `${match[1].toUpperCase()} ${match[2]}-${match[3]}`;
    found.set(file, file);
  }
  return [...found.values()];
}

export function wantsLegistarLookup(question: string): boolean {
  const text = cleanQuestion(question);
  if (!text) return false;
  if (legistarFileNumbers(text).length > 0) return true;
  if (asksAboutLegislation(text)) return true;
  return /\bwhat did the (?:village )?(?:board|council|trustees)\b/i.test(text);
}

function placeKeyword(question: string): string | null {
  const match = cleanQuestion(question).toLowerCase().match(/\b([a-z0-9]+(?:\s+[a-z0-9]+){0,2})\s+(street|avenue|road|boulevard|drive|lane|place|court)\b/);
  if (!match?.[1] || !match[2] || GENERIC_PLACE.has(match[1])) return null;
  const words = match[1].split(/\s+/).filter((word) => word.length > 1 && !PLACE_LEADING.has(word) && !BOILERPLATE.has(word));
  if (words.length === 0) return null;
  return `${words.join(" ")} ${match[2]}`;
}

/** Content words a matter title might contain, longest first. File numbers are separate. */
export function legistarKeywords(question: string): string[] {
  const text = cleanQuestion(question).toLowerCase().replace(/[^a-z0-9\s-]/g, " ");
  const words = text.split(/\s+/).filter((word) => word.length >= 4 && !BOILERPLATE.has(word) && !GENERIC_PLACE.has(word));
  const phrase = placeKeyword(question);
  const keywords = [...new Set([...(phrase ? [phrase] : []), ...words])];
  return keywords.sort((left, right) => right.length - left.length).slice(0, 3);
}

function stampToIso(stamp: number): string {
  const year = Math.floor(stamp / 10_000);
  const month = Math.floor((stamp % 10_000) / 100);
  const day = stamp % 100;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Lower bound for MatterIntroDate. Current rules stay inside the same 36-month window as record search. */
export function legistarIntroducedAfter(question: string, now: Date): string | undefined {
  const text = cleanQuestion(question);
  if (questionAsksAboutHistory(text)) return undefined;
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
  if (years.length > 0) return `${Math.min(...years)}-01-01`;
  const months = /\b(?:current|status|latest|recent|policy|policies|today|rules?)\b/i.test(text) ? 36 : 96;
  return stampToIso(shiftMonths(calendarStamp(now), months));
}

function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** OData filters: one exact file query, plus a specific keyword and a broader keyword. */
export function legistarFilters(question: string, now = new Date()): string[] {
  if (!wantsLegistarLookup(question)) return [];
  const files = legistarFileNumbers(question).slice(0, 3);
  const keywords = legistarKeywords(question);
  const after = legistarIntroducedAfter(question, now);
  const date = after ? ` and MatterIntroDate ge datetime'${after}'` : "";
  const filters: string[] = [];
  if (files.length > 0) filters.push(files.map((file) => `MatterFile eq ${odataString(file)}`).join(" or "));
  const specific = keywords[0];
  const broad = keywords.find((keyword) => keyword !== specific);
  if (specific) filters.push(`substringof(${odataString(specific)},MatterTitle)${date}`);
  if (broad) {
    filters.push(`substringof(${odataString(broad)},MatterTitle) and (MatterTypeName eq 'Ordinance' or MatterTypeName eq 'Motion' or MatterTypeName eq 'Resolution')${date}`);
  }
  return filters;
}

export function legistarMatterUrl(clientName: string, id: number, guid: string): string {
  return `https://${clientName}.legistar.com/LegislationDetail.aspx?ID=${id}&GUID=${guid}`;
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 10) return undefined;
  const iso = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : undefined;
}

export function parseLegistarMatters(payload: unknown, clientName: string): LegistarMatter[] {
  if (!Array.isArray(payload)) return [];
  const matters: LegistarMatter[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.MatterId === "number" ? row.MatterId : Number(row.MatterId);
    const guid = typeof row.MatterGuid === "string" ? row.MatterGuid.trim() : "";
    const file = typeof row.MatterFile === "string" ? row.MatterFile.trim() : "";
    const title = typeof row.MatterTitle === "string" ? row.MatterTitle.trim() : "";
    if (!Number.isFinite(id) || id <= 0 || !guid || !file || !title) continue;
    const body = typeof row.MatterBodyName === "string" ? row.MatterBodyName.trim() : "";
    matters.push({
      id,
      guid,
      file,
      title,
      typeName: typeof row.MatterTypeName === "string" && row.MatterTypeName.trim() ? row.MatterTypeName.trim() : "Matter",
      statusName: typeof row.MatterStatusName === "string" && row.MatterStatusName.trim() ? row.MatterStatusName.trim() : "Unknown",
      introDate: isoDate(row.MatterIntroDate),
      passedDate: isoDate(row.MatterPassedDate),
      agendaDate: isoDate(row.MatterAgendaDate),
      ...(body ? { bodyName: body } : {}),
      url: legistarMatterUrl(clientName, id, guid),
    });
  }
  return matters;
}

export function isPassedStatus(status: string): boolean {
  return /^(?:passed|adopted|approved|enacted)$/i.test(status.trim());
}

function isFirstReading(matter: LegistarMatter): boolean {
  return /first reading/i.test(`${matter.statusName} ${matter.title}`);
}

function isContractMatter(matter: LegistarMatter): boolean {
  return /\b(?:agreement|independent contractor|license|snow plow(?:ing)?|professional services)\b/i.test(matter.title);
}

function keywordHits(matter: LegistarMatter, keywords: string[]): string[] {
  const title = matter.title.toLowerCase();
  return keywords.filter((keyword) => title.includes(keyword.toLowerCase()));
}

function isCodeAmendment(matter: LegistarMatter): boolean {
  return /ordinance|motion/i.test(matter.typeName)
    && /\b(?:amending|village code|eligibility|section\s+\d)/i.test(matter.title);
}

function amendmentRank(matter: LegistarMatter): number {
  const title = matter.title;
  let score = 0;
  if (/\beligibility\b/i.test(title)) score += 3;
  if (/\bpermit\b/i.test(title)) score += 2;
  if (/\bfee\b/i.test(title)) score += 1;
  if (/second reading|adoption/i.test(title)) score += 2;
  if (/\b(?:free parking|garage|adjudication|map codified|waiver)\b/i.test(title)) score -= 3;
  return score;
}

function normalizeTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/\b(?:first|second|third)\s+reading(?:\s+and\s+(?:adoption|approval))?\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3 && !BOILERPLATE.has(word) && !["ordinance", "motion", "reading", "adoption", "adopt"].includes(word));
}

function sameMatterFamily(left: LegistarMatter, right: LegistarMatter): boolean {
  const a = new Set(normalizeTitle(left.title));
  const b = new Set(normalizeTitle(right.title));
  if (a.size < 4 || b.size < 4) return false;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const union = a.size + b.size - shared;
  return union > 0 && shared / union >= 0.72;
}

function byDateDesc(left: LegistarMatter, right: LegistarMatter): number {
  const stamp = (matter: LegistarMatter) => matter.passedDate || matter.agendaDate || matter.introDate || "";
  return stamp(right).localeCompare(stamp(left));
}

/**
 * Keep file-number hits, matters that match the distinctive keyword, and
 * passed code amendments for the broader keyword. A first reading of the
 * same title stays in the list so the answer can separate proposal from adoption.
 * Contract awards are left out of a rules or ordinance question.
 */
export function selectLegistarMatters(question: string, matters: LegistarMatter[]): LegistarMatter[] {
  const text = cleanQuestion(question);
  const keywords = legistarKeywords(text);
  const files = new Set(legistarFileNumbers(text).map((file) => file.toUpperCase()));
  const rulesQuestion = /\b(?:rules?|polic(?:y|ies)|ordinances?)\b/i.test(text);
  const specific = keywords[0]?.toLowerCase();
  const eligible = matters.filter((matter) => {
    if (files.has(matter.file.toUpperCase())) return true;
    if (rulesQuestion && isContractMatter(matter)) return false;
    const hits = keywordHits(matter, keywords);
    if (hits.length === 0) return false;
    if (keywords.length >= 2 && specific && !hits.includes(specific) && hits.length < 2 && !isCodeAmendment(matter)) return false;
    return true;
  });

  const pinned = eligible.filter((matter) => files.has(matter.file.toUpperCase()));
  const specificPassed = eligible
    .filter((matter) => specific && keywordHits(matter, [specific]).length > 0 && isPassedStatus(matter.statusName))
    .sort((left, right) => keywordHits(right, keywords).length - keywordHits(left, keywords).length || byDateDesc(left, right));
  // When the title can match every content word, drop one-word hits such as an overnight shelter grant.
  const multiWord = keywords.length >= 2 ? specificPassed.filter((matter) => keywordHits(matter, keywords).length >= 2) : [];
  const specificHits = (multiWord.length > 0 ? multiWord : specificPassed).slice(0, 4);
  const amendments = eligible
    .filter((matter) => isPassedStatus(matter.statusName) && isCodeAmendment(matter) && !specificHits.some((hit) => hit.id === matter.id))
    .sort((left, right) => amendmentRank(right) - amendmentRank(left) || keywordHits(right, keywords).length - keywordHits(left, keywords).length || byDateDesc(left, right))
    .slice(0, 4);
  const chosen = dedupeMatters([...pinned, ...specificHits, ...amendments]);
  const pairs = eligible.filter((matter) => isFirstReading(matter) && chosen.some((kept) => kept.id !== matter.id && sameMatterFamily(kept, matter)));
  return dedupeMatters([...chosen, ...pairs]).slice(0, 8);
}

/** Passed matters to search in the record store: distinctive hits first, then code amendments. */
export function legistarSearchMatters(question: string, selected: LegistarMatter[]): LegistarMatter[] {
  const keywords = legistarKeywords(question);
  const specific = keywords[0]?.toLowerCase();
  const passed = selected.filter((matter) => isPassedStatus(matter.statusName));
  const specificHits = passed.filter((matter) => specific && matter.title.toLowerCase().includes(specific));
  const amendments = passed.filter((matter) => isCodeAmendment(matter) && !specificHits.some((hit) => hit.id === matter.id));
  const files = passed.filter((matter) => legistarFileNumbers(question).some((file) => file.toUpperCase() === matter.file.toUpperCase()));
  return dedupeMatters([...files, ...specificHits.slice(0, 2), ...amendments.slice(0, 3)]).slice(0, 5);
}

function dedupeMatters(matters: LegistarMatter[]): LegistarMatter[] {
  const seen = new Set<number>();
  const out: LegistarMatter[] = [];
  for (const matter of matters) {
    if (seen.has(matter.id)) continue;
    seen.add(matter.id);
    out.push(matter);
  }
  return out;
}

export function matterRecordStamp(matter: LegistarMatter): number | undefined {
  const iso = matter.passedDate || matter.agendaDate || matter.introDate;
  if (!iso) return undefined;
  const stamp = Number(iso.replaceAll("-", ""));
  return Number.isFinite(stamp) ? stamp : undefined;
}

/** File number plus the distinctive part of the title, for a date-bounded record search. */
export function legistarVectorQuery(matter: LegistarMatter): string {
  const title = matter.title
    .replace(/\b(?:first|second|third) reading(?: and (?:adoption|approval))?(?: of)?\b/gi, " ")
    .replace(/\b(?:an|a) (?:ordinance|motion|resolution)\b/gi, " ")
    .replace(/\bto concur with the .+? recommendation to\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${matter.file} ${title}`.replace(/\s+/g, " ").trim().slice(0, 180);
}

export function describeLegistarMatter(matter: LegistarMatter): string {
  const dates = [
    matter.introDate ? `introduced ${matter.introDate}` : "",
    matter.passedDate ? `passed ${matter.passedDate}` : "",
  ].filter(Boolean).join(", ");
  const status = isPassedStatus(matter.statusName)
    ? `Status ${matter.statusName}: the board adopted this ${matter.typeName.toLowerCase()}${matter.passedDate ? ` on ${matter.passedDate}` : ""}. Do not describe it as only a proposal.`
    : isFirstReading(matter)
      ? `Status ${matter.statusName}: this is a first reading or proposal, not an adoption.`
      : `Status ${matter.statusName}.`;
  return [
    `${matter.file} (${matter.typeName}). ${dates}.`.replace(/\s+/g, " ").trim(),
    `Title: ${matter.title}`,
    status,
    matter.url,
  ].join("\n");
}

function mattersUrl(clientName: string, filter: string): string {
  const params = new URLSearchParams({
    $filter: filter,
    // A current-rules window can hold more than 50 parking matters. The cap has to
    // reach the oldest intro date in that window, or an adopted ordinance drops out.
    $top: "100",
    $orderby: "MatterIntroDate desc",
    $select: SELECT_FIELDS,
  });
  return `${LEGISTAR_API}/${clientName}/matters?${params}`;
}

async function readMatters(url: string, clientName: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<LegistarMatter[]> {
  const response = await fetchImpl(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Legistar responded ${response.status}`);
  return parseLegistarMatters(await response.json(), clientName);
}

/**
 * Keyword and file-number lookups in parallel. A failed request yields no
 * matters so the record search can still answer. `onlyFiles` is the follow-up
 * when an agenda names a file number the keyword query did not return.
 */
export async function queryLegistarMatters(input: {
  clientName: string;
  question: string;
  now?: Date;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onlyFiles?: string[];
}): Promise<LegistarMatter[]> {
  const now = input.now ?? new Date();
  const filters = input.onlyFiles && input.onlyFiles.length > 0
    ? [input.onlyFiles.slice(0, 3).map((file) => `MatterFile eq ${odataString(file)}`).join(" or ")]
    : legistarFilters(input.question, now);
  if (filters.length === 0) return [];
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeout = input.timeoutMs ?? LEGISTAR_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  try {
    const settled = await Promise.allSettled(filters.map((filter) => readMatters(mattersUrl(input.clientName, filter), input.clientName, fetchImpl, signal)));
    const matters = dedupeMatters(settled.flatMap((result) => result.status === "fulfilled" ? result.value : []));
    if (input.onlyFiles && input.onlyFiles.length > 0) return matters.slice(0, 3);
    return selectLegistarMatters(input.question, matters);
  } finally {
    clearTimeout(timer);
  }
}
