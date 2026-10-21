/**
 * Pure helpers for roll-call extraction.
 * The chat route does not import this module. Nothing here calls OpenAI or Supabase.
 */
import { createHash } from "node:crypto";

import { parseFilenameDate } from "./vector-store-tags";

export const EXTRACT_MODEL = "gpt-4.1-mini";
export const MAX_MINUTES_CHARS = 60_000;
export const PILOT_FILE_COUNT = 20;
export const BATCH_JSONL_BYTE_LIMIT = 150_000_000;

export type MinutesStatus = "approved" | "draft" | "revised" | "unknown";
export type MotionResult = "passed" | "failed" | "tabled" | "withdrawn" | "no_vote" | "unknown";
export type VoteChoice = "aye" | "nay" | "abstain" | "absent" | "recused";
export type ValidationStatus = "ok" | "tally_mismatch" | "needs_review" | "count_only";
export type NameMatchStatus = "matched" | "unknown" | "ambiguous";

const MINUTES_STATUSES: MinutesStatus[] = ["approved", "draft", "revised", "unknown"];
const MOTION_RESULTS: MotionResult[] = ["passed", "failed", "tabled", "withdrawn", "no_vote", "unknown"];
const VOTE_CHOICES: VoteChoice[] = ["aye", "nay", "abstain", "absent", "recused"];
const STATUS_RANK: Record<MinutesStatus, number> = { approved: 0, revised: 1, unknown: 2, draft: 3 };

const TITLE_PREFIX = /^(?:village president|vice president|president|trustee|mayor|alderman|alderwoman|alderperson|commissioner|chairwoman|chairman|chair|village clerk|clerk|vp)\.?\s+/i;
const TWO_PERSON_CLAIM = /\bonly (?:these )?two\b|\btwo named members\b|\bboth (?:of them )?voted\b/i;

export type VoteMember = {
  id: string;
  body: string;
  canonical_name: string;
  role: string | null;
  aliases: string[];
};

export type SeedMember = {
  body: string;
  canonical_name: string;
  role?: string | null;
  aliases?: string[];
};

export type StoredVote = {
  raw_name: string;
  choice: VoteChoice;
  member_id: string | null;
  match: NameMatchStatus;
};

export type StoredMotion = {
  item_key: string;
  item_number: string | null;
  title: string;
  motion_text: string | null;
  mover_raw: string | null;
  seconder_raw: string | null;
  mover_member_id: string | null;
  seconder_member_id: string | null;
  result: MotionResult;
  tally_aye: number | null;
  tally_nay: number | null;
  tally_abstain: number | null;
  tally_absent: number | null;
  tally_recused: number | null;
  tally_text: string | null;
  source_page: number | null;
  validation_status: ValidationStatus;
  validation_note: string;
  votes: StoredVote[];
};

export type StoredMeeting = {
  file_id: string;
  filename: string;
  record_date: number | null;
  untagged: boolean;
  truncated: boolean;
  meeting_date: string | null;
  body: string;
  minutes_status: MinutesStatus;
  date_disagrees: boolean;
  review_status: "ok" | "needs_review";
  review_note: string | null;
  superseded_by: string | null;
  error: string | null;
  /** Hash of the prompt, JSON schema, and model. An older hash is a cache miss. */
  extraction_version: string;
  motions: StoredMotion[];
};

export type ParsedMotion = {
  item_number: string | null;
  title: string;
  motion_text: string | null;
  mover_raw: string | null;
  seconder_raw: string | null;
  result: MotionResult;
  tally_aye: number | null;
  tally_nay: number | null;
  tally_abstain: number | null;
  tally_absent: number | null;
  tally_recused: number | null;
  tally_text: string | null;
  source_page: number | null;
  note: string | null;
  votes: { raw_name: string; choice: VoteChoice }[];
};

export type ParsedExtraction = {
  meeting_date: string | null;
  body: string;
  minutes_status: MinutesStatus;
  motions: ParsedMotion[];
};

/**
 * Incomplete on purpose. Deno reviews this before the full run.
 * Other trustees stay unmatched until their aliases are added.
 */
export const OAK_PARK_ALIAS_SEED: SeedMember[] = [
  {
    body: "Village Board",
    canonical_name: "Andrews",
    role: "Trustee",
    aliases: ["Trustee Andrews"],
  },
  {
    body: "Village Board",
    canonical_name: "Scaman",
    role: "Village President",
    aliases: ["President Scaman", "Village President Scaman"],
  },
  {
    body: "Village Board",
    canonical_name: "Walker-Peddakotla",
    role: "Trustee",
    aliases: ["Walker Peddakotla", "Trustee Walker-Peddakotla", "Trustee Walker Peddakotla"],
  },
];

export const EXTRACTION_INSTRUCTIONS = `You extract roll-call votes from one municipal minutes file. Return only JSON that matches the schema.

Rules:
- meeting_date is YYYY-MM-DD, or null when the text does not give a full date.
- body is the board or commission that met, such as Village Board.
- minutes_status is approved, draft, revised, or unknown.
- One object per motion. A consent agenda stays one motion. Do not split it into guessed items.
- Add a votes row for every name the roll call lists. That includes every absent, abstain, and recused name. Do not drop those names.
- Never take counts from meeting attendance. Who was present at the meeting is not the vote on a motion.
- For a voice vote, or when the minutes say unanimous and give no names and no numbers, leave every tally count null and leave votes empty. Do not invent a 7-0 or any other roll call.
- tally_text is the printed aye-nay split exactly, such as 6-1 or 7-0, or null. Never put a 5-part string in tally_text.
- The tally counts must equal the member rows you listed. Use null for a count the minutes do not print on that vote.
- When the printed roll call has a label (ABSTAIN, RECUSED, PRESENT), use that label for both the vote choice and the count, even if the narrative says otherwise. ABSTAIN means abstain. Use recused only when the line says RECUSED. PRESENT is not abstain or recused. tally_text is the aye-nay split only.
- choice is aye, nay, abstain, absent, or recused. Map yes and yea to aye. Map no to nay.
- source_page is an integer only when the text itself shows that page number. Otherwise null.
- A clerk who is not in the roll call is not a voting member.`;

const nullableString = { type: ["string", "null"] };
const nullableInteger = { type: ["integer", "null"] };

export const VOTE_EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["meeting_date", "body", "minutes_status", "motions"],
  properties: {
    meeting_date: nullableString,
    body: { type: "string" },
    minutes_status: { type: "string", enum: MINUTES_STATUSES },
    motions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "item_number",
          "title",
          "motion_text",
          "mover_raw",
          "seconder_raw",
          "result",
          "tally_aye",
          "tally_nay",
          "tally_abstain",
          "tally_absent",
          "tally_recused",
          "tally_text",
          "source_page",
          "note",
          "votes",
        ],
        properties: {
          item_number: nullableString,
          title: { type: "string" },
          motion_text: nullableString,
          mover_raw: nullableString,
          seconder_raw: nullableString,
          result: { type: "string", enum: MOTION_RESULTS },
          tally_aye: nullableInteger,
          tally_nay: nullableInteger,
          tally_abstain: nullableInteger,
          tally_absent: nullableInteger,
          tally_recused: nullableInteger,
          tally_text: nullableString,
          source_page: nullableInteger,
          note: nullableString,
          votes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["raw_name", "choice"],
              properties: {
                raw_name: { type: "string" },
                choice: { type: "string", enum: VOTE_CHOICES },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function extractionFingerprint(): string {
  return JSON.stringify({
    model: EXTRACT_MODEL,
    instructions: EXTRACTION_INSTRUCTIONS,
    schema: VOTE_EXTRACTION_SCHEMA,
  });
}

/** Changes when the system prompt, JSON schema, or model id changes. */
export const EXTRACTION_VERSION = createHash("sha256").update(extractionFingerprint()).digest("hex");

export function extractionVersionMatches(version: string | null | undefined): boolean {
  return version === EXTRACTION_VERSION;
}

export function cacheReuseSummary(input: { currentVersion: string; reused: string[]; stale: string[] }): string {
  const reusedFrom = formatVersions(input.reused);
  const reusedLine = input.reused.length > 0
    ? `Reused ${input.reused.length} cached results from extraction version ${reusedFrom}.`
    : `Reused 0 cached results. Current extraction version is ${input.currentVersion}.`;
  if (input.stale.length === 0) return reusedLine;
  return `${reusedLine} Ignored ${input.stale.length} cached results from extraction version ${formatVersions(input.stale)} because it does not match ${input.currentVersion}.`;
}

function formatVersions(versions: string[]): string {
  const counts = new Map<string, number>();
  for (const version of versions) {
    const label = version || "(none)";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([version, count]) => count > 1 ? `${version} (${count})` : version).join(", ");
}

export function extractionResponseBody(minutesText: string): {
  model: string;
  instructions: string;
  input: string;
  max_output_tokens: number;
  text: { format: { type: "json_schema"; name: string; strict: true; schema: typeof VOTE_EXTRACTION_SCHEMA } };
} {
  return {
    model: EXTRACT_MODEL,
    instructions: EXTRACTION_INSTRUCTIONS,
    input: minutesText,
    max_output_tokens: 16_000,
    text: {
      format: {
        type: "json_schema",
        name: "roll_call_votes",
        strict: true,
        schema: VOTE_EXTRACTION_SCHEMA,
      },
    },
  };
}

export function buildBatchRequestLine(fileId: string, minutesText: string): string {
  return JSON.stringify({
    custom_id: fileId,
    method: "POST",
    url: "/v1/responses",
    body: extractionResponseBody(minutesText),
  });
}

export function splitJsonlChunks(lines: string[], maxBytes: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line) + 1;
    if (bytes > maxBytes) throw new Error("One batch line is larger than the batch file limit.");
    if (current.length > 0 && size + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(line);
    size += bytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function readBatchOutputLine(line: string): { customId: string; outputText: string | null; error: string | null } {
  const parsed = JSON.parse(line) as {
    custom_id?: unknown;
    error?: unknown;
    response?: { status_code?: number; body?: { output_text?: unknown; output?: unknown } };
  };
  const customId = typeof parsed.custom_id === "string" ? parsed.custom_id : "";
  if (parsed.error) return { customId, outputText: null, error: JSON.stringify(parsed.error) };
  const status = parsed.response?.status_code;
  if (status != null && status !== 200) return { customId, outputText: null, error: `HTTP ${status}` };
  const body = parsed.response?.body;
  const outputText = typeof body?.output_text === "string" && body.output_text.trim()
    ? body.output_text
    : collectOutputText(body?.output);
  if (!outputText) return { customId, outputText: null, error: "Batch row had no output text." };
  return { customId, outputText, error: null };
}

function collectOutputText(output: unknown): string | null {
  if (!Array.isArray(output)) return null;
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

export function normalizePersonName(raw: string): string {
  let name = raw.trim().replace(/\s+/g, " ");
  let previous = "";
  while (name && name !== previous) {
    previous = name;
    name = name.replace(TITLE_PREFIX, "");
  }
  name = name.replace(/[.'"]/g, "");
  name = name.replace(/[-‐‑‒–—]/g, " ");
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

export function membersFromSeed(rows: SeedMember[]): VoteMember[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const body = row.body.trim();
    const canonical = row.canonical_name.trim();
    if (!body || !canonical) throw new Error("Each alias row needs a body and a canonical_name.");
    const key = `${body.toLowerCase()}|${canonical.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`Duplicate alias row for ${canonical} on ${body}.`);
    seen.add(key);
    return {
      id: `seed:${body}:${canonical}`,
      body,
      canonical_name: canonical,
      role: row.role?.trim() || null,
      aliases: (row.aliases ?? []).map((alias) => alias.trim()).filter(Boolean),
    };
  });
}

export function oakParkSeedMembers(): VoteMember[] {
  return membersFromSeed(OAK_PARK_ALIAS_SEED);
}

function bodiesMatch(memberBody: string, motionBody: string): boolean {
  const member = memberBody.trim().toLowerCase();
  const motion = motionBody.trim().toLowerCase();
  if (!member || !motion) return false;
  return member === motion || motion.includes(member) || member.includes(motion);
}

export function membersForBody(members: VoteMember[], body: string): VoteMember[] {
  const direct = members.filter((member) => bodiesMatch(member.body, body));
  if (direct.length > 0) return direct;
  const bodies = new Set(members.map((member) => member.body));
  if (bodies.size === 1) return members;
  return [];
}

export function matchMemberName(raw: string, members: VoteMember[]): { member_id: string | null; status: NameMatchStatus } {
  const normalized = normalizePersonName(raw);
  if (!normalized) return { member_id: null, status: "unknown" };
  const hits = members.filter((member) => {
    const names = [member.canonical_name, ...member.aliases];
    return names.some((name) => normalizePersonName(name) === normalized);
  });
  if (hits.length === 1) return { member_id: hits[0].id, status: "matched" };
  if (hits.length > 1) return { member_id: null, status: "ambiguous" };
  return { member_id: null, status: "unknown" };
}

export function countChoices(votes: { choice: VoteChoice }[]): Record<VoteChoice, number> {
  const counts: Record<VoteChoice, number> = { aye: 0, nay: 0, abstain: 0, absent: 0, recused: 0 };
  for (const vote of votes) counts[vote.choice] += 1;
  return counts;
}

export type TallyCheckStatus = "ok" | "tally_mismatch" | "needs_review" | "count_only";

function ayeNaySplit(text: string): { aye: number; nay: number } | null {
  const match = /^\s*(\d+)\s*[-–—]\s*(\d+)\s*$/.exec(text);
  if (!match) return null;
  return { aye: Number(match[1]), nay: Number(match[2]) };
}

function isMultiPartCount(text: string): boolean {
  const parts = text.split(/[-–—]/).map((part) => part.trim()).filter(Boolean);
  return parts.length > 2 && parts.every((part) => /^\d+$/.test(part));
}

export function validateTally(motion: {
  tally_aye: number | null;
  tally_nay: number | null;
  tally_abstain: number | null;
  tally_absent: number | null;
  tally_recused: number | null;
  tally_text: string | null;
  note: string | null;
  votes: { choice: VoteChoice }[];
}): { status: TallyCheckStatus; note: string } {
  const counts = countChoices(motion.votes);
  const problems: string[] = [];
  const notes: string[] = [];
  const text = motion.tally_text?.trim() ?? "";
  const split = ayeNaySplit(text);
  const noNames = motion.votes.length === 0;

  if (motion.tally_absent != null && motion.tally_absent !== counts.absent) {
    const listed = counts.absent === 0 ? "no absent names were listed" : `${counts.absent} absent names were listed`;
    notes.push(`tally_absent is ${motion.tally_absent} but ${listed}`);
  }

  if (!noNames) {
    const strictFields: [string, number | null, number][] = [
      ["aye", motion.tally_aye, counts.aye],
      ["nay", motion.tally_nay, counts.nay],
      ["abstain", motion.tally_abstain, counts.abstain],
      ["recused", motion.tally_recused, counts.recused],
    ];
    for (const [choice, printed, count] of strictFields) {
      if (printed == null) continue;
      if (!Number.isInteger(printed) || printed < 0 || printed !== count) {
        problems.push(`tally_${choice} is ${printed} but ${count} ${choice} names were listed`);
      }
    }
    if (split && (split.aye !== counts.aye || split.nay !== counts.nay)) {
      problems.push(`printed ${split.aye}-${split.nay} does not match ${counts.aye} aye and ${counts.nay} nay`);
    }
  } else if (split) {
    if (motion.tally_aye != null && motion.tally_aye !== split.aye) {
      problems.push(`tally_aye is ${motion.tally_aye} but the printed split is ${split.aye}-${split.nay}`);
    }
    if (motion.tally_nay != null && motion.tally_nay !== split.nay) {
      problems.push(`tally_nay is ${motion.tally_nay} but the printed split is ${split.aye}-${split.nay}`);
    }
  }

  if (/\bunanimous\b/i.test(text) && counts.nay > 0) {
    problems.push("printed unanimous does not match a nay");
  }
  if (isMultiPartCount(text)) {
    notes.push("tally_text must be the aye-nay split only, such as 6-1, not a longer count string.");
  }

  const claim = `${motion.note ?? ""} ${motion.tally_text ?? ""}`;
  const unanimous = motion.votes.length > 0 && counts.nay === 0 && counts.aye > 0
    && (split ? split.nay === 0 : counts.abstain === 0 && counts.recused === 0);
  if (TWO_PERSON_CLAIM.test(claim) && unanimous) {
    problems.push("a unanimous vote cannot be stored as a two-person split");
  }

  const combined = [...problems, ...notes].join("; ");
  if (problems.length > 0) return { status: "tally_mismatch", note: combined };
  if (noNames && split) {
    return { status: "count_only", note: [`Printed ${split.aye}-${split.nay} has no member names.`, ...notes].filter(Boolean).join(" ") };
  }
  if (noNames && (isMultiPartCount(text) || [motion.tally_aye, motion.tally_nay, motion.tally_abstain, motion.tally_recused, motion.tally_absent].some((count) => count != null && count > 0))) {
    return { status: "needs_review", note: combined || "Counts were given without member names or an aye-nay split." };
  }
  if (noNames) {
    return { status: "ok", note: notes.join("; ") || "No member rows and no printed split. Treated as a voice vote or a motion without a roll call." };
  }
  return { status: "ok", note: notes.join("; ") };
}

export function validationStatus(input: {
  tally: TallyCheckStatus;
  unknownOrAmbiguousName: boolean;
  dateDisagrees: boolean;
  untagged: boolean;
  missingDate: boolean;
}): ValidationStatus {
  if (input.tally === "tally_mismatch") return "tally_mismatch";
  if (input.tally === "count_only") return "count_only";
  if (input.tally === "needs_review" || input.unknownOrAmbiguousName || input.dateDisagrees || input.untagged || input.missingDate) {
    return "needs_review";
  }
  return "ok";
}

/** Empty text, or the vector-store placeholder for an image-only file, must not be sent to the model. */
export function unreadableMinutesReason(text: string): string | null {
  if (!text.trim()) return "Vector store content was empty.";
  if (text.includes("No text could be parsed")) return "Vector store content had no parseable text.";
  return null;
}

export function recordDateToIso(recordDate: number | null): string | null {
  if (recordDate == null || !Number.isInteger(recordDate)) return null;
  const text = String(recordDate);
  if (!/^(?:19|20)\d{6}$/.test(text)) return null;
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  const day = Number(text.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

export function parseIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  return recordDateToIso(Number(`${match[1]}${match[2]}${match[3]}`));
}

export function datesDisagree(meetingDate: string | null, recordDate: number | null): boolean {
  const recorded = recordDateToIso(recordDate);
  if (!meetingDate || !recorded) return false;
  return meetingDate !== recorded;
}

export function meetingYear(recordDate: number | null, filename: string): number | null {
  const iso = recordDateToIso(recordDate);
  if (iso) return Number(iso.slice(0, 4));
  const parsed = parseFilenameDate(filename);
  if (parsed.recordDate == null) return null;
  return Math.floor(parsed.recordDate / 10000);
}

export function inferMinutesStatus(modelStatus: MinutesStatus, filename: string): MinutesStatus {
  if (modelStatus !== "unknown") return modelStatus;
  if (/\bdraft\b/i.test(filename)) return "draft";
  if (/\brevised\b/i.test(filename)) return "revised";
  if (/\bapproved\b/i.test(filename)) return "approved";
  return "unknown";
}

export function inferBody(modelBody: string, filename: string): string {
  const trimmed = modelBody.trim();
  if (trimmed) return trimmed;
  if (/village\s*board|villageboard/i.test(filename)) return "Village Board";
  return "Unknown body";
}

export function classifyMinutesCandidate(documentType: string | null, filename: string): { include: boolean; untagged: boolean } {
  const tagged = documentType?.trim().toLowerCase() || "";
  if (tagged === "minutes") return { include: true, untagged: false };
  if (tagged) return { include: false, untagged: false };
  // Underscores are word characters, so a pattern like \bminutes\b misses "_Minutes.pdf".
  const label = filename.replace(/[_./-]+/g, " ").toLowerCase();
  if (/\b(?:agendas?|proposals?|rfps?|rfqs?|bids?|quotes?|studies|study|analysis|analyses)\b/.test(label)) {
    return { include: false, untagged: false };
  }
  if (/\bminutes\b/.test(label)) return { include: true, untagged: true };
  return { include: false, untagged: false };
}

export function attributeDocumentType(attributes: { [key: string]: string | number | boolean } | null | undefined): string | null {
  const value = attributes?.document_type;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function attributeRecordDate(attributes: { [key: string]: string | number | boolean } | null | undefined): number | null {
  const value = attributes?.record_date;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{8}$/.test(value)) return Number(value);
  return null;
}

export function selectSpread<T>(items: T[], limit: number, yearOf: (item: T) => number | null): T[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  if (items.length <= limit) return [...items];
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const year = yearOf(item);
    const key = year == null ? "unknown" : String(year);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const keys = [...groups.keys()].sort((left, right) => {
    if (left === "unknown") return 1;
    if (right === "unknown") return -1;
    return Number(left) - Number(right);
  });
  const chosen: T[] = [];
  let index = 0;
  while (chosen.length < limit) {
    let added = false;
    for (const key of keys) {
      const group = groups.get(key) ?? [];
      if (index < group.length) {
        chosen.push(group[index]);
        added = true;
        if (chosen.length === limit) break;
      }
    }
    if (!added) break;
    index += 1;
  }
  return chosen;
}

export function motionItemKey(itemNumber: string | null, title: string): string {
  const normalized = `${(itemNumber ?? "").trim().toLowerCase()}|${title.trim().toLowerCase().replace(/\s+/g, " ")}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

export function assignItemKeys(motions: { item_number: string | null; title: string }[]): string[] {
  const counts = new Map<string, number>();
  return motions.map((motion) => {
    const base = motionItemKey(motion.item_number, motion.title);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen + 1}`;
  });
}

export type MeetingCandidate = {
  id: string;
  body: string;
  meeting_date: string;
  minutes_status: MinutesStatus;
};

export type DedupeDecision = {
  id: string;
  superseded_by: string | null;
  review_status: "ok" | "needs_review";
  review_note: string | null;
};

export function dedupeMeetings(meetings: MeetingCandidate[]): DedupeDecision[] {
  const groups = new Map<string, MeetingCandidate[]>();
  for (const meeting of meetings) {
    const key = `${meeting.body.trim().toLowerCase()}|${meeting.meeting_date}`;
    const list = groups.get(key) ?? [];
    list.push(meeting);
    groups.set(key, list);
  }
  const decisions: DedupeDecision[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      decisions.push({ id: group[0].id, superseded_by: null, review_status: "ok", review_note: null });
      continue;
    }
    const best = Math.min(...group.map((meeting) => STATUS_RANK[meeting.minutes_status]));
    const winners = group.filter((meeting) => STATUS_RANK[meeting.minutes_status] === best);
    if (winners.length > 1) {
      const note = `More than one file shares the top minutes status (${winners[0].minutes_status}) for this body and date. A person needs to pick one.`;
      for (const meeting of group) {
        decisions.push({ id: meeting.id, superseded_by: null, review_status: "needs_review", review_note: note });
      }
      continue;
    }
    const winner = winners[0];
    for (const meeting of group) {
      if (meeting.id === winner.id) {
        decisions.push({ id: meeting.id, superseded_by: null, review_status: "ok", review_note: null });
      } else {
        decisions.push({
          id: meeting.id,
          superseded_by: winner.id,
          review_status: "ok",
          review_note: `Superseded by ${winner.id} (${winner.minutes_status}).`,
        });
      }
    }
  }
  return decisions;
}

function joinNotes(notes: (string | null | undefined)[]): string {
  return notes.map((note) => note?.trim()).filter((note): note is string => Boolean(note)).join(" ");
}

function integerOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function parseExtractionJson(raw: string): ParsedExtraction {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const minutesStatus = parsed.minutes_status;
  if (!MINUTES_STATUSES.includes(minutesStatus as MinutesStatus)) {
    throw new Error("minutes_status is missing or not a known value.");
  }
  if (!Array.isArray(parsed.motions)) throw new Error("motions must be an array.");
  const motions = parsed.motions.map((item) => parseMotion(item));
  return {
    meeting_date: parseIsoDate(typeof parsed.meeting_date === "string" ? parsed.meeting_date : null),
    body: typeof parsed.body === "string" ? parsed.body : "",
    minutes_status: minutesStatus as MinutesStatus,
    motions,
  };
}

function parseMotion(item: unknown): ParsedMotion {
  if (!item || typeof item !== "object") throw new Error("A motion was not an object.");
  const motion = item as Record<string, unknown>;
  const title = stringOrNull(motion.title);
  if (!title) throw new Error("A motion is missing a title.");
  if (!MOTION_RESULTS.includes(motion.result as MotionResult)) throw new Error(`Motion "${title}" has an unknown result.`);
  if (!Array.isArray(motion.votes)) throw new Error(`Motion "${title}" is missing votes.`);
  const votes = motion.votes.map((vote) => {
    if (!vote || typeof vote !== "object") throw new Error(`Motion "${title}" has a vote that is not an object.`);
    const row = vote as Record<string, unknown>;
    const rawName = stringOrNull(row.raw_name);
    if (!rawName) throw new Error(`Motion "${title}" has a vote without a name.`);
    if (!VOTE_CHOICES.includes(row.choice as VoteChoice)) throw new Error(`Motion "${title}" has an unknown choice for ${rawName}.`);
    return { raw_name: rawName, choice: row.choice as VoteChoice };
  });
  const page = integerOrNull(motion.source_page);
  return {
    item_number: stringOrNull(motion.item_number),
    title,
    motion_text: stringOrNull(motion.motion_text),
    mover_raw: stringOrNull(motion.mover_raw),
    seconder_raw: stringOrNull(motion.seconder_raw),
    result: motion.result as MotionResult,
    tally_aye: integerOrNull(motion.tally_aye),
    tally_nay: integerOrNull(motion.tally_nay),
    tally_abstain: integerOrNull(motion.tally_abstain),
    tally_absent: integerOrNull(motion.tally_absent),
    tally_recused: integerOrNull(motion.tally_recused),
    tally_text: stringOrNull(motion.tally_text),
    source_page: page != null && page >= 1 && page <= 500 ? page : null,
    note: stringOrNull(motion.note),
    votes,
  };
}

function collapseVotes(votes: { raw_name: string; choice: VoteChoice }[]): { votes: { raw_name: string; choice: VoteChoice }[]; conflict: boolean } {
  const byName = new Map<string, { raw_name: string; choice: VoteChoice }>();
  let conflict = false;
  for (const vote of votes) {
    const key = normalizePersonName(vote.raw_name);
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, vote);
      continue;
    }
    if (existing.choice !== vote.choice) conflict = true;
  }
  return { votes: [...byName.values()], conflict };
}

export function finalizeMeeting(input: {
  fileId: string;
  filename: string;
  recordDate: number | null;
  untagged: boolean;
  truncated: boolean;
  members: VoteMember[];
  model: ParsedExtraction;
  error?: string | null;
}): StoredMeeting {
  const body = inferBody(input.model.body, input.filename);
  const meetingDate = input.model.meeting_date;
  const dateDisagrees = datesDisagree(meetingDate, input.recordDate);
  const missingDate = meetingDate == null;
  const roster = membersForBody(input.members, body);
  const keys = assignItemKeys(input.model.motions);
  const reviewNotes = [
    input.untagged ? "File was not already tagged as minutes." : null,
    dateDisagrees ? `Extracted date ${meetingDate} does not match record_date ${input.recordDate}.` : null,
    missingDate ? "No meeting date was extracted." : null,
    input.truncated ? "Minutes text was truncated before extraction." : null,
  ];

  const motions: StoredMotion[] = input.model.motions.map((motion, index) => {
    const collapsed = collapseVotes(motion.votes);
    const tally = validateTally({ ...motion, votes: collapsed.votes });
    const storedVotes: StoredVote[] = collapsed.votes.map((vote) => {
      const match = matchMemberName(vote.raw_name, roster);
      return { raw_name: vote.raw_name, choice: vote.choice, member_id: match.member_id, match: match.status };
    });
    const nameNotes = storedVotes.flatMap((vote) => {
      if (vote.match === "unknown") return [`Unknown name: ${vote.raw_name}.`];
      if (vote.match === "ambiguous") return [`Ambiguous name: ${vote.raw_name} matches more than one member.`];
      return [];
    });
    const status = validationStatus({
      tally: collapsed.conflict ? "tally_mismatch" : tally.status,
      unknownOrAmbiguousName: storedVotes.some((vote) => vote.match !== "matched") && storedVotes.length > 0,
      dateDisagrees,
      untagged: input.untagged,
      missingDate,
    });
    const counts = countChoices(storedVotes);
    const fill = (given: number | null, count: number) => {
      if (given != null) return given;
      if (status === "ok" && storedVotes.length > 0) return count;
      return null;
    };
    const mover = motion.mover_raw ? matchMemberName(motion.mover_raw, roster) : null;
    const seconder = motion.seconder_raw ? matchMemberName(motion.seconder_raw, roster) : null;
    return {
      item_key: keys[index],
      item_number: motion.item_number,
      title: motion.title,
      motion_text: motion.motion_text,
      mover_raw: motion.mover_raw,
      seconder_raw: motion.seconder_raw,
      mover_member_id: mover?.status === "matched" ? mover.member_id : null,
      seconder_member_id: seconder?.status === "matched" ? seconder.member_id : null,
      result: motion.result,
      tally_aye: fill(motion.tally_aye, counts.aye),
      tally_nay: fill(motion.tally_nay, counts.nay),
      tally_abstain: fill(motion.tally_abstain, counts.abstain),
      tally_absent: fill(motion.tally_absent, counts.absent),
      tally_recused: fill(motion.tally_recused, counts.recused),
      tally_text: motion.tally_text,
      source_page: motion.source_page,
      validation_status: status,
      validation_note: joinNotes([
        collapsed.conflict ? "The same name was listed with two choices." : null,
        tally.note,
        motion.note,
        ...nameNotes,
      ]),
      votes: storedVotes,
    };
  });

  const meetingNeedsReview = input.untagged || dateDisagrees || missingDate || Boolean(input.error);
  return {
    file_id: input.fileId,
    filename: input.filename,
    record_date: input.recordDate,
    untagged: input.untagged,
    truncated: input.truncated,
    meeting_date: meetingDate,
    body,
    minutes_status: inferMinutesStatus(input.model.minutes_status, input.filename),
    date_disagrees: dateDisagrees,
    review_status: meetingNeedsReview ? "needs_review" : "ok",
    review_note: joinNotes(reviewNotes) || null,
    superseded_by: null,
    error: input.error ?? null,
    extraction_version: EXTRACTION_VERSION,
    motions,
  };
}

export function revalidateMeeting(meeting: StoredMeeting): StoredMeeting {
  const missingDate = meeting.meeting_date == null;
  return {
    ...meeting,
    motions: meeting.motions.map((motion) => {
      const tally = validateTally({
        tally_aye: motion.tally_aye,
        tally_nay: motion.tally_nay,
        tally_abstain: motion.tally_abstain,
        tally_absent: motion.tally_absent,
        tally_recused: motion.tally_recused,
        tally_text: motion.tally_text,
        note: null,
        votes: motion.votes,
      });
      const unknownOrAmbiguousName = motion.votes.some((vote) => vote.match !== "matched") && motion.votes.length > 0;
      const nameNotes = motion.votes.flatMap((vote) => {
        if (vote.match === "unknown") return [`Unknown name: ${vote.raw_name}.`];
        if (vote.match === "ambiguous") return [`Ambiguous name: ${vote.raw_name} matches more than one member.`];
        return [];
      });
      return {
        ...motion,
        validation_status: validationStatus({
          tally: tally.status,
          unknownOrAmbiguousName,
          dateDisagrees: meeting.date_disagrees,
          untagged: meeting.untagged,
          missingDate,
        }),
        validation_note: joinNotes([tally.note, ...nameNotes]),
      };
    }),
  };
}

export function failedMeeting(input: {
  fileId: string;
  filename: string;
  recordDate: number | null;
  untagged: boolean;
  error: string;
}): StoredMeeting {
  return {
    file_id: input.fileId,
    filename: input.filename,
    record_date: input.recordDate,
    untagged: input.untagged,
    truncated: false,
    meeting_date: recordDateToIso(input.recordDate),
    body: inferBody("", input.filename),
    minutes_status: inferMinutesStatus("unknown", input.filename),
    date_disagrees: false,
    review_status: "needs_review",
    review_note: input.error,
    superseded_by: null,
    error: input.error,
    extraction_version: EXTRACTION_VERSION,
    motions: [],
  };
}

export function applyDedupe(meetings: StoredMeeting[]): StoredMeeting[] {
  const candidates: MeetingCandidate[] = [];
  for (const meeting of meetings) {
    if (!meeting.meeting_date || meeting.error) continue;
    candidates.push({
      id: meeting.file_id,
      body: meeting.body,
      meeting_date: meeting.meeting_date,
      minutes_status: meeting.minutes_status,
    });
  }
  const decisions = new Map(dedupeMeetings(candidates).map((decision) => [decision.id, decision]));
  return meetings.map((meeting) => {
    const decision = decisions.get(meeting.file_id);
    if (!decision) return meeting;
    const tied = decision.superseded_by == null && (decision.review_note?.startsWith("More than one file") ?? false);
    const motions = tied
      ? meeting.motions.map((motion) => motion.validation_status === "ok"
        ? { ...motion, validation_status: "needs_review" as const, validation_note: joinNotes([motion.validation_note, decision.review_note]) }
        : motion)
      : meeting.motions;
    const reviewStatus = meeting.review_status === "needs_review" || decision.review_status === "needs_review" ? "needs_review" as const : "ok" as const;
    return {
      ...meeting,
      motions,
      superseded_by: decision.superseded_by,
      review_status: reviewStatus,
      review_note: joinNotes([meeting.review_note, decision.review_note]) || null,
    };
  });
}

export function tagCacheTextIsUsable(text: string | null | undefined): boolean {
  if (!text || text.trim().length < 500) return false;
  return /\b(roll call|ayes?|nays?|voted|motion)\b/i.test(text);
}

const REVIEW_COLUMNS = [
  "file_id",
  "filename",
  "meeting_date",
  "minutes_status",
  "item_number",
  "title",
  "result",
  "tally_text",
  "tally_aye",
  "tally_nay",
  "names",
  "validation_status",
  "note",
  "source_page",
] as const;

function csvCell(value: string | number | null | undefined): string {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function meetingsToReviewCsv(meetings: StoredMeeting[]): string {
  const lines = [REVIEW_COLUMNS.join(",")];
  for (const meeting of meetings) {
    if (meeting.motions.length === 0) {
      lines.push(reviewRow(meeting, null));
      continue;
    }
    for (const motion of meeting.motions) lines.push(reviewRow(meeting, motion));
  }
  return `${lines.join("\n")}\n`;
}

function reviewRow(meeting: StoredMeeting, motion: StoredMotion | null): string {
  const names = motion?.votes.map((vote) => `${vote.raw_name}:${vote.choice}`).join("; ") ?? "";
  const note = joinNotes([meeting.review_note, motion?.validation_note, meeting.error]);
  const values = [
    meeting.file_id,
    meeting.filename,
    meeting.meeting_date,
    meeting.minutes_status,
    motion?.item_number,
    motion?.title,
    motion?.result,
    motion?.tally_text,
    motion?.tally_aye,
    motion?.tally_nay,
    names,
    motion?.validation_status ?? meeting.review_status,
    note,
    motion?.source_page,
  ];
  return values.map((value) => csvCell(value)).join(",");
}

export function meetingsToJsonl(meetings: StoredMeeting[]): string {
  return `${meetings.map((meeting) => JSON.stringify(meeting)).join("\n")}\n`;
}

export function reviewCsvPath(jsonlPath: string): string {
  return `${jsonlPath.replace(/\.jsonl$/i, "")}.review.csv`;
}

export function isStoredMeeting(value: unknown): value is StoredMeeting {
  if (!value || typeof value !== "object") return false;
  const meeting = value as Partial<StoredMeeting>;
  return typeof meeting.file_id === "string" && Array.isArray(meeting.motions) && typeof meeting.filename === "string";
}
