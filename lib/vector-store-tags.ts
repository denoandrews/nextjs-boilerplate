import { filenameSourceUrl, safeHttpsUrl } from "./source-links";

/**
 * Proposed vector-store attributes and the CSV review file.
 * Chat search does not import this module.
 */

export const DOCUMENT_TYPES = [
  "ordinance",
  "agenda",
  "minutes",
  "budget",
  "form",
  "policy",
  "staff_report",
  "proposal",
  "study",
  "news",
  "resolution",
  "other",
] as const;

export const STATUS_VALUES = ["current", "superseded", "draft"] as const;

export const CSV_COLUMNS = [
  "file_id",
  "filename",
  "city",
  "source_url",
  "record_date",
  "document_type",
  "status",
  "title",
  "date_source",
  "confidence",
  "needs_review",
  "notes",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export type RecordStatus = (typeof STATUS_VALUES)[number];
export type DateSource = "filename" | "content" | "none";
export type Confidence = "high" | "medium" | "low";

export type TagProposal = {
  file_id: string;
  filename: string;
  city: string;
  source_url: string;
  record_date: string;
  document_type: string;
  status: string;
  title: string;
  date_source: DateSource;
  confidence: Confidence;
  needs_review: "yes" | "no";
  notes: string;
};

export type ProposeInput = {
  fileId: string;
  filename: string;
  city: string;
  /** Opening text. Null means the text was not read. An empty string means it was read and was empty. */
  text?: string | null;
  contentNote?: string | null;
  externalUrl?: string | null;
  storedTitle?: string | null;
  storedType?: string | null;
  vectorStatus?: string | null;
};

const MONTH_INDEX: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

const MONTH_PATTERN = "January|February|March|April|May|June|July|August|September|October|November|December|Sept|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec";

const DATE_LABEL = /\b(?:meeting date|date of (?:the )?meeting|meeting held(?: on)?|held on|adopted(?: on)?|adoption date|date adopted|effective date|passed and approved|approved(?: on)?|ordained and passed)\b|\bdate\s*:/i;

type FoundDate = {
  date: number;
  index: number;
  ambiguous: boolean;
};

export function calendarDate(year: number, month: number, day: number): number | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return year * 10000 + month * 100 + day;
}

export function normalizeLabel(value: string): string {
  return value
    .replace(/['’]/g, "")
    .replace(/[_./]+/g, " ")
    .replace(/[-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.\\/]+$/, "");
  const withoutLeadingDate = base.replace(/^(?:19|20)\d{2}-\d{2}-\d{2}[_\s-]*/, "");
  const title = withoutLeadingDate.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  return (title || base || "Untitled document").slice(0, 512);
}

export function filenameHasIsoDate(filename: string): boolean {
  return parseFilenameDate(filename).recordDate != null;
}

export function parseFilenameDate(filename: string): { recordDate: number | null; confidence: "high" | "low" | null; notes: string } {
  const found: number[] = [];
  for (const match of filename.matchAll(/(?:^|[^0-9])((?:19|20)\d{2})-(\d{2})-(\d{2})(?![0-9])/g)) {
    const date = calendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date != null) found.push(date);
  }
  if (found.length === 0) return { recordDate: null, confidence: null, notes: "" };
  if (found.length === 1) return { recordDate: found[0], confidence: "high", notes: "Date taken from YYYY-MM-DD in the filename." };
  const unique = [...new Set(found)];
  if (/revised/i.test(filename)) {
    const latest = Math.max(...unique);
    return {
      recordDate: latest,
      confidence: "high",
      notes: `Filename says revised. Used the later date ${latest} instead of ${unique.filter((date) => date !== latest).join(", ")}.`,
    };
  }
  return {
    recordDate: unique[0],
    confidence: "low",
    notes: `Filename has more than one YYYY-MM-DD date (${unique.join(", ")}). Kept the first for review.`,
  };
}

function ignoredDateContext(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 30), index).toLowerCase();
  return /copyright|©|printed|phone|fax|\btel\b/.test(before);
}

function findContentDates(text: string): FoundDate[] {
  const found: FoundDate[] = [];
  const patterns: RegExp[] = [
    new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s+((?:19|20)\\d{2})\\b`, "gi"),
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\.?\\s*,?\\s+((?:19|20)\\d{2})\\b`, "gi"),
    /(?:^|[^0-9])((?:19|20)\d{2})-(\d{2})-(\d{2})(?![0-9])/g,
    /\b(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})\b/g,
  ];

  const push = (date: number | null, index: number, ambiguous: boolean) => {
    if (date == null || ignoredDateContext(text, index)) return;
    found.push({ date, index, ambiguous });
  };

  for (const match of text.matchAll(patterns[0])) {
    const month = MONTH_INDEX[match[1].toLowerCase()];
    push(calendarDate(Number(match[3]), month, Number(match[2])), match.index ?? 0, false);
  }
  for (const match of text.matchAll(patterns[1])) {
    const month = MONTH_INDEX[match[2].toLowerCase()];
    push(calendarDate(Number(match[3]), month, Number(match[1])), match.index ?? 0, false);
  }
  for (const match of text.matchAll(patterns[2])) {
    push(calendarDate(Number(match[1]), Number(match[2]), Number(match[3])), match.index ?? 0, false);
  }
  for (const match of text.matchAll(patterns[3])) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = Number(match[3]);
    const monthFirst = calendarDate(year, first, second);
    const dayFirst = calendarDate(year, second, first);
    if (monthFirst != null && (first > 12 || second > 12 || monthFirst === dayFirst)) {
      push(monthFirst, match.index ?? 0, false);
    } else if (monthFirst != null) {
      push(monthFirst, match.index ?? 0, true);
    } else if (dayFirst != null) {
      push(dayFirst, match.index ?? 0, false);
    }
  }

  found.sort((left, right) => left.index - right.index);
  const seen = new Set<string>();
  return found.filter((item) => {
    const key = `${item.index}:${item.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasDateLabel(text: string, index: number): boolean {
  return DATE_LABEL.test(text.slice(Math.max(0, index - 60), index));
}

export function parseContentDate(text: string): { recordDate: number | null; confidence: Confidence; notes: string } {
  const window = text.slice(0, 5000);
  const found = findContentDates(window);
  if (found.length === 0) return { recordDate: null, confidence: "low", notes: "No date in the opening text." };

  const labeled = found.filter((item) => hasDateLabel(window, item.index));
  if (labeled.length > 0) {
    const distinct = [...new Set(labeled.map((item) => item.date))];
    const chosen = labeled[0];
    if (distinct.length === 1 && !chosen.ambiguous) {
      return { recordDate: chosen.date, confidence: "high", notes: "Labeled meeting, adoption, or effective date near the top." };
    }
    const why = distinct.length > 1
      ? `Several labeled dates (${distinct.join(", ")}). Kept the first.`
      : "Labeled date could be read as either month/day or day/month. Kept month/day.";
    return { recordDate: chosen.date, confidence: "low", notes: why };
  }

  const header = found.filter((item) => item.index < 1500);
  const pool = header.length > 0 ? header : found;
  const distinct = [...new Set(pool.map((item) => item.date))];
  const chosen = pool[0];
  if (header.length > 0 && distinct.length === 1 && !chosen.ambiguous) {
    return {
      recordDate: chosen.date,
      confidence: "medium",
      notes: "Single date near the top, without a meeting or adoption label.",
    };
  }
  const why = chosen.ambiguous
    ? "Date near the top could be read as either month/day or day/month. Kept month/day."
    : `Several dates near the top (${distinct.join(", ")}). Kept the first.`;
  return { recordDate: chosen.date, confidence: "low", notes: why };
}

const TYPE_RULES: { type: DocumentType; pattern: RegExp }[] = [
  { type: "proposal", pattern: /\b(?:rfps?|rfqs?|request for proposals?|request for bids?|request for quotes?|proposals?|bids?|bidders?|quotes?|quotations?)\b/ },
  { type: "staff_report", pattern: /\b(?:village |city |town )?(?:managers?|staff) reports?\b/ },
  { type: "study", pattern: /\b(?:study sessions?|planning stud(?:y|ies)|plan stud(?:y|ies)|remedial action plans?|action plans?|studies|study|analyses|analysis)\b/ },
  { type: "minutes", pattern: /\bminutes\b/ },
  { type: "agenda", pattern: /\bagendas?\b/ },
  { type: "budget", pattern: /\b(?:budgets?|appropriations?)\b|\bfy\s*'?-?\s*\d{2,4}\b/ },
  { type: "ordinance", pattern: /\b(?:ordinances?|municipal codes?|village codes?|city codes?|zoning)\b/ },
  { type: "resolution", pattern: /\bresolutions?\b/ },
  { type: "form", pattern: /\b(?:forms?|applications?)\b/ },
  { type: "policy", pattern: /\b(?:policies|policy|guidelines?)\b/ },
  { type: "news", pattern: /\bnews\b/ },
];

export function classifyDocumentType(filename: string, title: string): { documentType: DocumentType; notes: string } {
  const label = normalizeLabel(`${filename} ${title}`);
  if (TYPE_RULES[0].pattern.test(label)) return { documentType: "proposal", notes: "Type proposal from proposal, RFP, bid, or quote in the name." };
  if (TYPE_RULES[1].pattern.test(label)) return { documentType: "staff_report", notes: "Type staff_report from a manager's or staff report in the name." };
  if (TYPE_RULES[2].pattern.test(label)) return { documentType: "study", notes: "Type study from a study, analysis, or plan study in the name." };

  let winner: { type: DocumentType; index: number } | null = null;
  for (const rule of TYPE_RULES.slice(3)) {
    const match = rule.pattern.exec(label);
    if (!match || match.index < 0) continue;
    if (!winner || match.index < winner.index) winner = { type: rule.type, index: match.index };
  }
  if (!winner) return { documentType: "other", notes: "No type keyword in the filename or title." };
  return { documentType: winner.type, notes: `Type ${winner.type} from the filename or title.` };
}

const STORED_TYPE_MAP: Record<string, DocumentType> = {
  ordinance: "ordinance",
  law: "ordinance",
  resolution: "resolution",
  minutes: "minutes",
  agenda: "agenda",
  policy: "policy",
  guideline: "policy",
  guidelines: "policy",
  news: "news",
  budget: "budget",
  form: "form",
  application: "form",
  staff_report: "staff_report",
  "staff report": "staff_report",
  proposal: "proposal",
  study: "study",
  other: "other",
};

function appendNote(notes: string[], note: string) {
  const trimmed = note.trim();
  if (trimmed) notes.push(trimmed);
}

function fiscalYear(filename: string, title: string, recordDate: string): number | null {
  const match = normalizeLabel(`${filename} ${title}`).match(/\bfy\s*'?-?\s*(\d{2}|\d{4})\b/);
  if (match) {
    const year = Number(match[1]);
    if (match[1].length === 2) return 2000 + year;
    if (year >= 1900 && year <= 2100) return year;
  }
  if (/^\d{8}$/.test(recordDate)) return Number(recordDate.slice(0, 4));
  return null;
}

export function proposeTag(input: ProposeInput): TagProposal {
  const notes: string[] = [];
  const filenameDate = parseFilenameDate(input.filename);
  let recordDate = filenameDate.recordDate;
  let dateSource: DateSource = filenameDate.recordDate == null ? "none" : "filename";
  let dateConfidence: Confidence | null = filenameDate.confidence;
  appendNote(notes, filenameDate.notes);

  if (recordDate == null) {
    if (input.text == null) {
      dateSource = "none";
      dateConfidence = "low";
      appendNote(notes, input.contentNote || "No YYYY-MM-DD in the filename, and the document text was not read.");
    } else {
      const contentDate = parseContentDate(input.text);
      if (contentDate.recordDate == null) {
        dateSource = "none";
        dateConfidence = "low";
        appendNote(notes, contentDate.notes);
        appendNote(notes, input.contentNote || "");
      } else {
        recordDate = contentDate.recordDate;
        dateSource = "content";
        dateConfidence = contentDate.confidence;
        appendNote(notes, contentDate.notes);
        appendNote(notes, input.contentNote || "");
      }
    }
  }

  const storedTitle = input.storedTitle?.replace(/\s+/g, " ").trim() || "";
  const title = (storedTitle || titleFromFilename(input.filename)).slice(0, 512);
  if ((storedTitle || titleFromFilename(input.filename)).length > 512) appendNote(notes, "Title was cut at 512 characters.");

  const classified = classifyDocumentType(input.filename, title);
  let documentType: DocumentType = classified.documentType;
  appendNote(notes, classified.notes);

  const storedType = input.storedType ? STORED_TYPE_MAP[normalizeLabel(input.storedType)] : undefined;
  if (storedType && storedType !== "other" && documentType === "other") {
    documentType = storedType;
    dateConfidence = dateConfidence === "high" ? "medium" : dateConfidence;
    appendNote(notes, `Type ${storedType} taken from Supabase because the filename had no type keyword.`);
  } else if (storedType && storedType !== documentType && storedType !== "other") {
    dateConfidence = "low";
    appendNote(notes, `Supabase document_type is ${storedType}, which does not match ${documentType}.`);
  }

  const label = normalizeLabel(`${input.filename} ${title}`);
  let status = "";
  if (/\bdraft\b/.test(label)) {
    status = "draft";
    appendNote(notes, "Status draft from the word draft in the name.");
  } else if (/\bsuperseded\b/.test(label)) {
    status = "superseded";
    appendNote(notes, "Status superseded from the word superseded in the name.");
  }

  let sourceUrl = "";
  const storedUrl = input.externalUrl ? safeHttpsUrl(input.externalUrl) : null;
  if (input.externalUrl && !storedUrl) {
    dateConfidence = "low";
    appendNote(notes, "Supabase external_url was not a usable https URL.");
  } else if (storedUrl && storedUrl.length > 512) {
    dateConfidence = "low";
    appendNote(notes, "Supabase external_url is longer than 512 characters and was left blank.");
  } else if (storedUrl) {
    sourceUrl = storedUrl;
  } else {
    const embedded = input.filename.match(/https:\/\/[^\s<>"']+/i);
    const embeddedUrl = embedded ? safeHttpsUrl(embedded[0].replace(/[),.;]+$/g, "")) : null;
    if (embeddedUrl && embeddedUrl.length <= 512) sourceUrl = embeddedUrl;
    else if (input.city === "oak-park-il") sourceUrl = filenameSourceUrl(input.city, input.filename) ?? "";
  }

  if (input.vectorStatus && input.vectorStatus !== "completed") {
    dateConfidence = "low";
    appendNote(notes, `Vector store status is ${input.vectorStatus}.`);
  }

  let confidence: Confidence;
  if (documentType === "other" || dateSource === "none" || dateConfidence === "low" || dateConfidence == null) confidence = "low";
  else if (dateConfidence === "medium") confidence = "medium";
  else confidence = "high";

  const needsReview = confidence === "high" ? "no" : "yes";

  return {
    file_id: input.fileId,
    filename: input.filename,
    city: input.city,
    source_url: sourceUrl,
    record_date: recordDate == null ? "" : String(recordDate),
    document_type: documentType,
    status,
    title,
    date_source: dateSource,
    confidence,
    needs_review: needsReview,
    notes: notes.join(" "),
  };
}

export function finalizeProposals(rows: TagProposal[]): TagProposal[] {
  const next = rows.map((row) => ({ ...row }));
  const candidates = next.flatMap((row) => {
    if (row.document_type !== "budget" || row.status !== "") return [];
    const year = fiscalYear(row.filename, row.title, row.record_date);
    return year == null ? [] : [{ row, year }];
  });
  const distinct = new Set(candidates.map((item) => item.year));
  if (distinct.size < 2) return next;
  const newest = Math.max(...candidates.map((item) => item.year));
  for (const item of candidates) {
    if (item.year === newest) {
      item.row.status = "current";
      item.row.notes = `${item.row.notes} Newest budget year ${newest}, so status is current.`.trim();
    } else {
      item.row.status = "superseded";
      item.row.notes = `${item.row.notes} Older budget year ${item.year}, superseded by ${newest}.`.trim();
    }
  }
  return next;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function tagsToCsv(rows: TagProposal[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map((column) => csvEscape(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

export function parseTagsCsv(text: string): TagProposal[] {
  const table = parseCsvTable(text);
  if (table.length === 0) throw new Error("The CSV is empty.");
  const header = table[0].map((cell) => cell.trim());
  const missing = CSV_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) throw new Error(`The CSV is missing columns: ${missing.join(", ")}.`);
  const index = new Map(header.map((cell, position) => [cell, position]));
  return table.slice(1).map((cells) => {
    const value = (column: (typeof CSV_COLUMNS)[number]) => cells[index.get(column) ?? -1] ?? "";
    const dateSource = value("date_source");
    const confidence = value("confidence");
    const needsReview = value("needs_review").trim().toLowerCase();
    if (dateSource !== "filename" && dateSource !== "content" && dateSource !== "none") {
      throw new Error(`file ${value("file_id") || "(blank)"} has an unknown date_source.`);
    }
    if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
      throw new Error(`file ${value("file_id") || "(blank)"} has an unknown confidence.`);
    }
    if (needsReview !== "yes" && needsReview !== "no") {
      throw new Error(`file ${value("file_id") || "(blank)"} needs_review must be yes or no.`);
    }
    return {
      file_id: value("file_id").trim(),
      filename: value("filename"),
      city: value("city").trim(),
      source_url: value("source_url").trim(),
      record_date: value("record_date").trim(),
      document_type: value("document_type").trim(),
      status: value("status").trim(),
      title: value("title").trim(),
      date_source: dateSource,
      confidence,
      needs_review: needsReview,
      notes: value("notes"),
    };
  });
}

function parseCsvTable(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === "\"") {
        if (source[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === "\"") {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

export type ApplyDecision =
  | { action: "skip"; reason: string }
  | { action: "apply"; attributes: Record<string, string | number> };

export function attributesForRow(row: TagProposal): ApplyDecision {
  if (row.needs_review === "yes") return { action: "skip", reason: "needs_review" };
  if (!row.file_id.startsWith("file-")) return { action: "skip", reason: "file_id must start with file-" };
  if (!row.city) return { action: "skip", reason: "city is empty" };

  const documentType = normalizeLabel(row.document_type).replace(/ /g, "_");
  if (!documentType) return { action: "skip", reason: "needs_review was cleared but document_type is still empty" };
  if (!DOCUMENT_TYPES.includes(documentType as DocumentType)) {
    return { action: "skip", reason: `document_type ${row.document_type} is not a known type` };
  }

  const attributes: Record<string, string | number> = {
    city: row.city,
    document_type: documentType,
  };
  const title = row.title.slice(0, 512).trim();
  if (title) attributes.title = title;

  if (row.record_date) {
    if (!/^\d{8}$/.test(row.record_date)) return { action: "skip", reason: "record_date is not YYYYMMDD" };
    const date = calendarDate(Number(row.record_date.slice(0, 4)), Number(row.record_date.slice(4, 6)), Number(row.record_date.slice(6, 8)));
    if (date == null) return { action: "skip", reason: "record_date is not a real calendar date" };
    attributes.record_date = date;
  }

  if (row.status) {
    const status = row.status.toLowerCase();
    if (!STATUS_VALUES.includes(status as RecordStatus)) {
      return { action: "skip", reason: "status must be current, superseded, draft, or blank" };
    }
    attributes.status = status;
  }

  if (row.source_url) {
    const url = safeHttpsUrl(row.source_url);
    if (!url) return { action: "skip", reason: "source_url is not an https URL" };
    if (url.length > 512) return { action: "skip", reason: "source_url is longer than 512 characters" };
    attributes.source_url = url;
  }

  return { action: "apply", attributes };
}

export function decodeFileContent(bytes: Uint8Array, contentType: string | null):
  | { kind: "text"; text: string }
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "unsupported"; note: string } {
  const type = (contentType ?? "").toLowerCase();
  const header = Buffer.from(bytes.subarray(0, 5)).toString("utf8");
  if (type.includes("pdf") || header.startsWith("%PDF")) return { kind: "pdf", bytes };
  if (type.includes("text") || type.includes("json") || type.includes("xml") || type.includes("html") || isMostlyText(bytes)) {
    return { kind: "text", text: Buffer.from(bytes).toString("utf8") };
  }
  return { kind: "unsupported", note: "File content was neither text nor a PDF." };
}

function isMostlyText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, 1000);
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127)) printable += 1;
  }
  return printable / sample.length > 0.9;
}
