import type OpenAI from "openai";
import type { ComparisonFilter } from "openai/resources/shared";

/**
 * File-search tuning for municipal records.
 *
 * Oak Park files have document_type, title, status, and city. Hundreds still
 * have no record_date. A filter on a missing attribute drops the file, so
 * record_date is never a filter. document_type is filtered only for Oak Park,
 * and only for types that are safe to require. A lone ordinance filter is not
 * applied: the current rule often lives in guidelines or a policy file.
 * A question about an adopted ordinance, rule, resolution, or motion is not
 * narrowed to one document type: the filter also includes minutes, agendas,
 * ordinances, and resolutions. Everything else stays unfiltered.
 *
 * The attribute index is ranked by similarity times a recency boost: 1.3 within
 * 18 months and 1.15 within 36 months. Undated files are not penalized, and a
 * history question gets no boost. The hosted file-search tool still ranks by
 * relevance; this list is what tells the model which records are recent.
 */

export const FILE_SEARCH_MAX_RESULTS = 24;

export const FILE_SEARCH_RANKING_OPTIONS = {
  ranker: "auto" as const,
  hybrid_search: {
    embedding_weight: 0.5,
    text_weight: 0.5,
  },
};

const ATTRIBUTE_SEARCH_TIMEOUT_MS = 8_000;

/** Slugs where every vector-store file has a document_type attribute. */
const DOCUMENT_TYPE_READY = new Set(["oak-park-il"]);

const DOCUMENT_TYPE_CUES: { type: string; pattern: RegExp }[] = [
  { type: "minutes", pattern: /\b(?:minutes|actas)\b/i },
  { type: "agenda", pattern: /\bagendas?\b|\borden del d[ií]a\b/i },
  { type: "budget", pattern: /\bbudgets?\b|\bpresupuestos?\b/i },
  { type: "ordinance", pattern: /\bordinances?\b|\bordenanzas?\b/i },
];

/** Types that can hold an adopted ordinance, resolution, or motion. Motion text usually lives on an agenda or in the minutes. */
const LEGISLATIVE_DOCUMENT_TYPES = ["minutes", "agenda", "ordinance", "resolution"];

const LEGISLATIVE_QUESTION =
  /\b(?:ordinances?|laws?|rules?|resolutions?|motions?|adopted|adoption|polic(?:y|ies)|ordenanzas?|leyes|reglas|resoluciones|mociones|adoptad[oa]s?)\b/i;

export function asksAboutLegislation(question: string): boolean {
  return LEGISLATIVE_QUESTION.test(question);
}

const MEETING_WORD = /\b(?:meetings?|reuniones|reuni[oó]n)\b/i;
const RECENCY_WORD = /\b(?:next|upcoming|latest|most recent|last|pr[oó]xim[oa]s?|[uú]ltim[oa]s?)\b/i;
const BROAD_CORPUS =
  /\b(?:history|historical|over the years|every time|how many times|all votes|all the votes|every vote|matrix of votes|how many meetings|historia|cada vez|cu[aá]ntas veces|todos los votos)\b/i;

export type AttributeHit = {
  fileId: string;
  filename: string;
  title?: string;
  recordDate?: number;
  documentType?: string;
  status?: string;
  /** Similarity score from vector store search. Missing scores are treated as equal, not as zero. */
  score?: number;
  /** Relevance times the date boost. Set by rankAttributeHits. */
  rankScore?: number;
};

/** Records dated within this many months get the stronger recency boost. */
export const DATE_BOOST_RECENT_MONTHS = 18;
/** Records dated within this many months, but not the recent window, get a smaller boost. */
export const DATE_BOOST_NEAR_MONTHS = 36;
export const DATE_BOOST_RECENT = 1.3;
export const DATE_BOOST_NEAR = 1.15;

const HISTORY_QUESTION =
  /\b(?:histories|history|historical|historia|over the years|through the years)\b/i;

export function questionAsksAboutHistory(question: string): boolean {
  return HISTORY_QUESTION.test(question);
}

export function calendarStamp(now: Date, timeZone = "America/Chicago"): number {
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return Number(iso.replaceAll("-", ""));
}

/** Calendar months before a YYYYMMDD stamp, clamping the day to the target month. */
export function shiftMonths(stamp: number, months: number): number {
  const year = Math.floor(stamp / 10_000);
  const month = Math.floor((stamp % 10_000) / 100);
  const day = stamp % 100;
  const anchor = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate();
  return anchor.getUTCFullYear() * 10_000 + (anchor.getUTCMonth() + 1) * 100 + Math.min(day, lastDay);
}

/**
 * Relevance multiplier for a record date. Undated files stay at 1, so a missing
 * date is not treated as old. History questions get no boost.
 */
export function dateBoostFor(recordDate: number | undefined, nowStamp: number, skip: boolean): number {
  if (skip || recordDate === undefined) return 1;
  if (recordDate >= shiftMonths(nowStamp, DATE_BOOST_RECENT_MONTHS)) return DATE_BOOST_RECENT;
  if (recordDate >= shiftMonths(nowStamp, DATE_BOOST_NEAR_MONTHS)) return DATE_BOOST_NEAR;
  return 1;
}

export function rankAttributeHits(
  hits: AttributeHit[],
  options: { question?: string; now?: Date; timeZone?: string } = {},
): AttributeHit[] {
  const nowStamp = calendarStamp(options.now ?? new Date(), options.timeZone ?? "America/Chicago");
  const skip = options.question ? questionAsksAboutHistory(options.question) : false;
  const unique = new Map<string, AttributeHit & { index: number; rankScore: number }>();
  hits.forEach((hit, index) => {
    if (!hit.fileId) return;
    const score = typeof hit.score === "number" && Number.isFinite(hit.score) ? hit.score : 1;
    const next = { ...hit, score, rankScore: score * dateBoostFor(hit.recordDate, nowStamp, skip), index };
    const existing = unique.get(hit.fileId);
    if (existing && existing.rankScore >= next.rankScore) return;
    unique.set(hit.fileId, existing ? { ...next, index: existing.index } : next);
  });
  return [...unique.values()]
    .sort((left, right) => right.rankScore - left.rankScore || left.index - right.index)
    .slice(0, FILE_SEARCH_MAX_RESULTS)
    .map(({ fileId, filename, title, recordDate, documentType, status, score, rankScore }) => ({
      fileId,
      filename,
      title,
      recordDate,
      documentType,
      status,
      score,
      rankScore,
    }));
}

export function fileSearchFilters(question: string, slug: string): ComparisonFilter | undefined {
  if (!DOCUMENT_TYPE_READY.has(slug)) return undefined;
  if (BROAD_CORPUS.test(question)) return undefined;

  const found = new Set<string>();
  for (const cue of DOCUMENT_TYPE_CUES) {
    if (cue.pattern.test(question)) found.add(cue.type);
  }
  if (MEETING_WORD.test(question) && RECENCY_WORD.test(question)) {
    found.add("minutes");
    found.add("agenda");
  }

  const types = DOCUMENT_TYPE_CUES.map((cue) => cue.type).filter((type) => found.has(type));
  if (types.length === 0) return undefined;
  // Guidelines and policies are a better source than an ordinance for many
  // "what is the rule" questions, and they are not document_type=ordinance.
  if (types.length === 1 && types[0] === "ordinance") return undefined;
  // An adopted change can be a motion in an agenda or the minutes, not only an ordinance file.
  if (asksAboutLegislation(question)) {
    const extras = types.filter((type) => !LEGISLATIVE_DOCUMENT_TYPES.includes(type));
    return { type: "in", key: "document_type", value: [...LEGISLATIVE_DOCUMENT_TYPES, ...extras] };
  }
  if (types.length === 1) return { type: "eq", key: "document_type", value: types[0] };
  return { type: "in", key: "document_type", value: types };
}

export function fileSearchTool(vectorStoreIds: string[], filters?: ComparisonFilter) {
  return {
    type: "file_search" as const,
    vector_store_ids: vectorStoreIds,
    max_num_results: FILE_SEARCH_MAX_RESULTS,
    ranking_options: FILE_SEARCH_RANKING_OPTIONS,
    ...(filters ? { filters } : {}),
  };
}

export function recordDateNumber(value: string | number | boolean | undefined): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 19_000_101 && value <= 21_001_231) return value;
  if (typeof value === "string" && /^\d{8}$/.test(value)) {
    const parsed = Number(value);
    if (parsed >= 19_000_101 && parsed <= 21_001_231) return parsed;
  }
  return undefined;
}

function attributeText(attributes: { [key: string]: string | number | boolean } | null | undefined, key: string) {
  const value = attributes?.[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : undefined;
}

export function formatAttributeIndex(
  hits: AttributeHit[],
  options: { question?: string; now?: Date; timeZone?: string } = {},
): string | null {
  const rows = rankAttributeHits(hits, options);
  if (rows.length === 0) return null;

  const lines = rows.map((row) => {
    const status = row.status ? ` | status: ${row.status}` : "";
    return `- filename: ${row.filename || "unknown"} | title: ${row.title || "none"} | record_date: ${row.recordDate ?? "none"} | document_type: ${row.documentType || "none"}${status}`;
  });

  return [
    "Attribute index for this question. It is not the full archive. Match each filename to the file-search passages. record_date is YYYYMMDD, so 20261013 is October 13, 2026. record_date none means the file has no date attribute; still use it, and take the date from the filename or heading. Rows are ranked by relevance. A record under 18 months old is boosted, and a record under 36 months old is boosted less. Undated files are not penalized. There is no recency boost when the question asks about history.",
    ...lines,
  ].join("\n");
}

function isCallerAbort(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  return error.name === "AbortError" || error.name === "APIUserAbortError";
}

export async function loadAttributeIndex(
  client: OpenAI,
  input: {
    slug: string;
    vectorStoreIds: string[];
    question: string;
    filters?: ComparisonFilter;
    signal?: AbortSignal;
    requestId?: string;
  },
): Promise<string | null> {
  if (!DOCUMENT_TYPE_READY.has(input.slug)) return null;
  const search = client.vectorStores?.search;
  if (typeof search !== "function") return null;

  try {
    const hits: AttributeHit[] = [];
    for (const vectorStoreId of input.vectorStoreIds) {
      const page = await search.call(
        client.vectorStores,
        vectorStoreId,
        {
          query: input.question,
          max_num_results: FILE_SEARCH_MAX_RESULTS,
          ranking_options: { ranker: "auto" as const },
          rewrite_query: true,
          ...(input.filters ? { filters: input.filters } : {}),
        },
        { timeout: ATTRIBUTE_SEARCH_TIMEOUT_MS, signal: input.signal },
      );
      const rows = page && Array.isArray(page.data) ? page.data : [];
      for (const result of rows) {
        const attributes = result.attributes;
        hits.push({
          fileId: result.file_id,
          filename: result.filename,
          score: typeof result.score === "number" ? result.score : undefined,
          title: attributeText(attributes, "title"),
          recordDate: recordDateNumber(attributes?.record_date),
          documentType: attributeText(attributes, "document_type"),
          status: attributeText(attributes, "status"),
        });
      }
    }
    return formatAttributeIndex(hits, { question: input.question });
  } catch (error) {
    if (isCallerAbort(error)) throw error;
    console.error(`[${input.requestId ?? "chat"}] Attribute index search failed.`, error);
    return null;
  }
}
