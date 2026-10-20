/**
 * Extract roll-call votes from minutes already in an OpenAI vector store.
 *
 * The default run writes JSONL and a review CSV. It does not write to Supabase.
 * --write upserts by stable keys after the SQL migration has been applied.
 * This script never uploads or deletes municipal vector-store files.
 * The chat route does not import this script.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import OpenAI, { toFile } from "openai";

import { applyAttemptBudgetMs, retryOperation, withDeadline } from "../lib/vector-store-apply-log";
import { readScanCache } from "../lib/vector-store-tag-cache";
import {
  BATCH_JSONL_BYTE_LIMIT,
  EXTRACT_MODEL,
  MAX_MINUTES_CHARS,
  PILOT_FILE_COUNT,
  applyDedupe,
  attributeDocumentType,
  attributeRecordDate,
  buildBatchRequestLine,
  classifyMinutesCandidate,
  extractionResponseBody,
  failedMeeting,
  finalizeMeeting,
  isStoredMeeting,
  matchMemberName,
  meetingYear,
  meetingsToJsonl,
  meetingsToReviewCsv,
  membersForBody,
  membersFromSeed,
  oakParkSeedMembers,
  parseExtractionJson,
  readBatchOutputLine,
  reviewCsvPath,
  selectSpread,
  splitJsonlChunks,
  tagCacheTextIsUsable,
  type SeedMember,
  type StoredMeeting,
  type VoteMember,
} from "../lib/vote-extraction";

type Candidate = {
  fileId: string;
  filename: string;
  recordDate: number | null;
  untagged: boolean;
  year: number | null;
};

type TextCache = {
  filename: string;
  text: string;
  truncated: boolean;
  source: "vector-store" | "tag-cache";
  recordDate: number | null;
  untagged: boolean;
};

type BatchState = {
  vectorStoreId: string;
  activeBatchId: string | null;
  submittedFileIds: string[];
};

const { values } = parseArgs({
  options: {
    help: { type: "boolean", default: false },
    pilot: { type: "boolean", default: false },
    batch: { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    refresh: { type: "boolean", default: false },
    "retry-failed": { type: "boolean", default: false },
    "no-seed": { type: "boolean", default: false },
    limit: { type: "string" },
    out: { type: "string" },
    csv: { type: "string" },
    cache: { type: "string" },
    "tag-cache": { type: "string" },
    aliases: { type: "string" },
    "api-key": { type: "string" },
    "vector-store": { type: "string" },
    city: { type: "string" },
    "delay-ms": { type: "string" },
    "timeout-ms": { type: "string" },
    "batch-wait-ms": { type: "string" },
    "supabase-url": { type: "string" },
    "supabase-key": { type: "string" },
  },
  strict: true,
});

function printHelp() {
  console.log(`Usage:
  npm run extract-votes -- --pilot --out oak-park-votes-pilot.jsonl
  npm run extract-votes -- --batch --out oak-park-votes.jsonl
  npm run extract-votes -- --write --out oak-park-votes-pilot.jsonl

The pilot uses the regular API and writes JSONL plus a review CSV. It does not write to Supabase.
--batch submits the full run to the Batch API. Re-run the same command to collect a finished batch.
--write upserts meetings, motions, and member votes. Paste the roll-call SQL migration first.
--limit N caps the file count. With --pilot, the files are spread across years (default 20).
--timeout-ms defaults to 120000. Each call has 2 client retries and 3 attempts.
A later run skips files already extracted. --refresh extracts them again. --retry-failed reruns failures only.

Required: OPENAI_API_KEY and VECTOR_STORE_ID (or --api-key and --vector-store).
Required for --write: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and MUNICIPALITY_SLUG or --city.
Oak Park example:
  export OPENAI_API_KEY="sk-..."
  export VECTOR_STORE_ID="vs_697291646f88819190c616d2a4c98955"
  export MUNICIPALITY_SLUG="oak-park-il"
  npm run extract-votes -- --pilot --out oak-park-votes-pilot.jsonl`);
}

async function main() {
  if (values.help) {
    printHelp();
    return;
  }
  if (values.pilot && values.batch) throw new Error("The pilot uses the regular API. Omit --batch.");
  if (values.refresh && values["retry-failed"]) throw new Error("Pass only one of --refresh or --retry-failed.");

  const apiKey = values["api-key"] || process.env.OPENAI_API_KEY || "";
  const vectorStoreId = values["vector-store"] || process.env.VECTOR_STORE_ID || process.env.VECTOR_STORE_IDS?.split(",")[0]?.trim() || "";
  const city = (values.city || process.env.MUNICIPALITY_SLUG || process.env.CITY || "").trim();
  const supabaseUrl = values["supabase-url"] || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const supabaseKey = values["supabase-key"] || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const delayMs = Number(values["delay-ms"] ?? "200");
  const timeoutMs = Number(values["timeout-ms"] ?? "120000");
  const batchWaitMs = Number(values["batch-wait-ms"] ?? "20000");
  const limit = values.limit == null ? (values.pilot ? PILOT_FILE_COUNT : null) : Number(values.limit);

  if (!apiKey) throw new Error("Set OPENAI_API_KEY or pass --api-key.");
  if (!vectorStoreId) throw new Error("Set VECTOR_STORE_ID or pass --vector-store.");
  assertSafeId("vector store id", vectorStoreId);
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("--delay-ms must be a number that is zero or greater.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms must be a positive integer.");
  if (!Number.isInteger(batchWaitMs) || batchWaitMs < 0) throw new Error("--batch-wait-ms must be zero or a positive integer.");
  if (limit != null && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer.");
  if (city && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(city)) {
    throw new Error("MUNICIPALITY_SLUG or --city must be a lowercase slug such as oak-park-il.");
  }
  if (values.write) {
    if (!supabaseUrl || !supabaseKey) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before --write.");
    if (!city) throw new Error("Set MUNICIPALITY_SLUG or pass --city before --write.");
  }

  const outPath = values.out || "vote-extraction.jsonl";
  const csvPath = values.csv || reviewCsvPath(outPath);
  const cacheDir = values.cache || ".vote-extract-cache";
  const tagCacheDir = values["tag-cache"] || ".vector-store-tag-cache";
  const logPath = `${outPath}.extract.log`;
  const members = loadMembers(city);
  const openai = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 2 });
  const pace = createPacer(delayMs);
  const attemptBudget = applyAttemptBudgetMs(timeoutMs, 2);

  console.log(`Extracting roll-call votes with ${EXTRACT_MODEL} from ${vectorStoreId}.`);
  console.log("Municipal files are not uploaded or deleted. Supabase is updated only with --write.");
  console.log(`Each request times out after ${timeoutMs}ms, with 2 client retries, and a file is abandoned after 3 attempts.`);
  if (values.pilot) console.log(`Pilot: ${limit} files spread across years, using the regular API.`);
  if (values.batch) console.log("Batch mode submits /v1/responses and returns if the batch is still running.");

  const listed = await listVectorStoreFiles(openai, vectorStoreId, pace, timeoutMs, attemptBudget, logPath);
  const candidates = await selectCandidates(openai, listed, pace, timeoutMs, attemptBudget, logPath, cacheDir, vectorStoreId);
  const chosen = values.pilot
    ? selectSpread(candidates, limit ?? PILOT_FILE_COUNT, (candidate) => candidate.year)
    : limit == null ? candidates : candidates.slice(0, limit);
  console.log(`Selected ${chosen.length} minutes files from ${candidates.length} candidates.`);

  const context = {
    openai, vectorStoreId, cacheDir, tagCacheDir, logPath, members, pace, timeoutMs, attemptBudget,
    refresh: values.refresh,
    retryFailed: values["retry-failed"],
  };

  let ready = true;
  if (values.batch) {
    ready = await runBatch(context, chosen, batchWaitMs);
  } else {
    await runRegular(context, chosen);
  }

  if (!ready) {
    console.log("The batch is still running. Re-run the same command to collect it. Supabase was not updated.");
    return;
  }

  const meetings = applyDedupe(chosen.map((candidate) => readExtractionCache(cacheDir, vectorStoreId, candidate.fileId)
    ?? failedMeeting({
      fileId: candidate.fileId,
      filename: candidate.filename,
      recordDate: candidate.recordDate,
      untagged: candidate.untagged,
      error: "This file was not extracted.",
    })));
  writeFileSync(outPath, meetingsToJsonl(meetings));
  writeFileSync(csvPath, meetingsToReviewCsv(meetings));
  const motions = meetings.flatMap((meeting) => meeting.motions);
  const mismatches = motions.filter((motion) => motion.validation_status === "tally_mismatch").length;
  const review = motions.filter((motion) => motion.validation_status === "needs_review").length;
  const failed = meetings.filter((meeting) => meeting.error).length;
  console.log(`Wrote ${meetings.length} meetings to ${outPath} and ${csvPath}.`);
  console.log(`Motions: ${motions.length}. tally_mismatch: ${mismatches}. needs_review: ${review}. File errors: ${failed}.`);

  if (values.write) {
    await writeSupabase({ supabaseUrl, supabaseKey, city, meetings, members });
  } else {
    console.log("Supabase was not updated. Review the CSV, then re-run with --write.");
  }
  if (failed > 0) process.exitCode = 1;
}

type RunContext = {
  openai: OpenAI;
  vectorStoreId: string;
  cacheDir: string;
  tagCacheDir: string;
  logPath: string;
  members: VoteMember[];
  pace: () => Promise<void>;
  timeoutMs: number;
  attemptBudget: number;
  refresh: boolean;
  retryFailed: boolean;
};

async function runRegular(context: RunContext, chosen: Candidate[]) {
  let extracted = 0;
  let skipped = 0;
  let failed = 0;
  for (const candidate of chosen) {
    const cached = context.refresh ? null : readExtractionCache(context.cacheDir, context.vectorStoreId, candidate.fileId);
    if (context.retryFailed) {
      if (!cached?.error) {
        skipped += 1;
        continue;
      }
    } else if (cached && !cached.error) {
      skipped += 1;
      logChange(context.logPath, `skipped ${candidate.fileId} already extracted`);
      continue;
    }
    try {
      const text = await loadMinutesText(context, candidate);
      if (!text.text.trim()) {
        const meeting = failedMeeting({ ...candidateFields(candidate), error: "Vector store content was empty." });
        writeExtractionCache(context.cacheDir, context.vectorStoreId, meeting);
        failed += 1;
        logChange(context.logPath, `failed ${candidate.fileId} vector store content was empty`);
        continue;
      }
      const response = await callWithTimeout(
        context,
        (signal) => context.openai.responses.create(
          extractionResponseBody(promptText(text.text, text.truncated)),
          { signal, timeout: context.timeoutMs, maxRetries: 2 },
        ),
        candidate.fileId,
      );
      const output = response.output_text?.trim();
      if (!output) throw new Error("The model returned no text.");
      const meeting = finalizeMeeting({
        ...candidateFields(candidate),
        truncated: text.truncated,
        members: context.members,
        model: parseExtractionJson(output),
      });
      writeExtractionCache(context.cacheDir, context.vectorStoreId, meeting);
      extracted += 1;
      logChange(context.logPath, `extracted ${candidate.fileId} ${meeting.motions.length} motions`);
    } catch (error) {
      const meeting = failedMeeting({ ...candidateFields(candidate), error: errorMessage(error) });
      writeExtractionCache(context.cacheDir, context.vectorStoreId, meeting);
      failed += 1;
      logChange(context.logPath, `failed ${candidate.fileId} ${errorMessage(error)}`);
    }
  }
  console.log(`Regular API finished. Extracted ${extracted}. Skipped ${skipped}. Failed ${failed}.`);
}

async function runBatch(context: RunContext, chosen: Candidate[], batchWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + batchWaitMs;
  const byId = new Map(chosen.map((candidate) => [candidate.fileId, candidate]));
  const attempted = new Set<string>();
  let state = readBatchState(context.cacheDir, context.vectorStoreId);

  for (;;) {
    if (state?.activeBatchId) {
      const finished = await pollBatch(context, state, byId, deadline);
      if (!finished) return false;
      state = readBatchState(context.cacheDir, context.vectorStoreId);
    }

    const pending = chosen.filter((candidate) => {
      if (attempted.has(candidate.fileId)) return false;
      const cached = context.refresh ? null : readExtractionCache(context.cacheDir, context.vectorStoreId, candidate.fileId);
      if (context.retryFailed) return Boolean(cached?.error);
      return !cached || Boolean(cached.error);
    });
    if (pending.length === 0) return true;

    const lines: string[] = [];
    for (const candidate of pending) {
      const text = await loadMinutesText(context, candidate);
      if (!text.text.trim()) {
        attempted.add(candidate.fileId);
        const meeting = failedMeeting({ ...candidateFields(candidate), error: "Vector store content was empty." });
        writeExtractionCache(context.cacheDir, context.vectorStoreId, meeting);
        logChange(context.logPath, `failed ${candidate.fileId} vector store content was empty`);
        continue;
      }
      lines.push(buildBatchRequestLine(candidate.fileId, promptText(text.text, text.truncated)));
    }
    if (lines.length === 0) continue;

    const chunks = splitJsonlChunks(lines, BATCH_JSONL_BYTE_LIMIT);
    const first = chunks[0];
    const submittedFileIds = first.map((line) => JSON.parse(line).custom_id as string);
    const uploaded = await callWithTimeout(
      context,
      (signal) => toFile(Buffer.from(`${first.join("\n")}\n`), "vote-extraction-batch.jsonl", { type: "application/jsonl" }).then((file) =>
        context.openai.files.create({
          file,
          purpose: "batch",
        }, { signal, timeout: context.timeoutMs, maxRetries: 2 }),
      ),
      "batch-upload",
    );
    const batch = await callWithTimeout(
      context,
      (signal) => context.openai.batches.create({
        input_file_id: uploaded.id,
        endpoint: "/v1/responses",
        completion_window: "24h",
      }, { signal, timeout: context.timeoutMs, maxRetries: 2 }),
      "batch-create",
    );
    state = { vectorStoreId: context.vectorStoreId, activeBatchId: batch.id, submittedFileIds };
    writeBatchState(context.cacheDir, state);
    logChange(context.logPath, `extracted batch ${batch.id} submitted ${submittedFileIds.length} files`);
    console.log(`Submitted batch ${batch.id} for ${submittedFileIds.length} files. ${chunks.length - 1} more chunk(s) wait until this one finishes.`);
    for (const fileId of submittedFileIds) attempted.add(fileId);
  }
}

async function pollBatch(context: RunContext, state: BatchState, byId: Map<string, Candidate>, deadline: number): Promise<boolean> {
  const batchId = state.activeBatchId;
  if (!batchId) return true;
  while (Date.now() <= deadline) {
    await context.pace();
    const batch = await context.openai.batches.retrieve(batchId, { timeout: context.timeoutMs, maxRetries: 2 });
    console.log(`Batch ${batchId} status: ${batch.status}.`);
    if (batch.status === "completed") {
      if (!batch.output_file_id) throw new Error(`Batch ${batchId} completed without an output file.`);
      const output = await downloadBatchOutput(context.openai, batch.output_file_id);
      ingestBatchOutput(context, output, byId);
      writeBatchState(context.cacheDir, { ...state, activeBatchId: null, submittedFileIds: [] });
      return true;
    }
    if (batch.status === "failed" || batch.status === "expired" || batch.status === "cancelled") {
      if (batch.error_file_id) {
        const errors = await downloadBatchOutput(context.openai, batch.error_file_id);
        logChange(context.logPath, `failed ${batchId} ${errors.slice(0, 500)}`);
      }
      writeBatchState(context.cacheDir, { ...state, activeBatchId: null, submittedFileIds: [] });
      throw new Error(`Batch ${batchId} ${batch.status}. Re-run --batch to submit the remaining files.`);
    }
    if (Date.now() + 5000 > deadline) break;
    await sleep(5000);
  }
  console.log(`Batch ${batchId} is not finished. Re-run the same command to resume.`);
  return false;
}

function ingestBatchOutput(context: RunContext, output: string, byId: Map<string, Candidate>) {
  for (const line of output.split(/\n/)) {
    if (!line.trim()) continue;
    const row = readBatchOutputLine(line);
    if (!row.customId) continue;
    const candidate = byId.get(row.customId);
    const cachedText = readTextCache(context.cacheDir, context.vectorStoreId, row.customId);
    const filename = candidate?.filename || cachedText?.filename || row.customId;
    const recordDate = candidate?.recordDate ?? cachedText?.recordDate ?? null;
    const untagged = candidate?.untagged ?? cachedText?.untagged ?? false;
    if (row.error || !row.outputText) {
      const meeting = failedMeeting({
        fileId: row.customId,
        filename,
        recordDate,
        untagged,
        error: row.error || "Batch row had no output text.",
      });
      writeExtractionCache(context.cacheDir, context.vectorStoreId, meeting);
      logChange(context.logPath, `failed ${row.customId} ${meeting.error}`);
      continue;
    }
    try {
      const meeting = finalizeMeeting({
        fileId: row.customId,
        filename,
        recordDate,
        untagged,
        truncated: cachedText?.truncated ?? false,
        members: context.members,
        model: parseExtractionJson(row.outputText),
      });
      writeExtractionCache(context.cacheDir, context.vectorStoreId, meeting);
      logChange(context.logPath, `extracted ${row.customId} ${meeting.motions.length} motions`);
    } catch (error) {
      const meeting = failedMeeting({
        fileId: row.customId,
        filename,
        recordDate,
        untagged,
        error: errorMessage(error),
      });
      writeExtractionCache(context.cacheDir, context.vectorStoreId, meeting);
      logChange(context.logPath, `failed ${row.customId} ${errorMessage(error)}`);
    }
  }
}

async function downloadBatchOutput(openai: OpenAI, outputFileId: string): Promise<string> {
  const response = await openai.files.content(outputFileId);
  if (!response.ok) throw new Error(`Batch output download failed (HTTP ${response.status}).`);
  return response.text();
}

async function listVectorStoreFiles(
  openai: OpenAI,
  vectorStoreId: string,
  pace: () => Promise<void>,
  timeoutMs: number,
  attemptBudget: number,
  logPath: string,
): Promise<{ id: string; status: string; attributes?: { [key: string]: string | number | boolean } | null }[]> {
  const files: { id: string; status: string; attributes?: { [key: string]: string | number | boolean } | null }[] = [];
  await pace();
  const page = await retryOperation(
    () => withDeadline(
      (signal) => Promise.resolve(openai.vectorStores.files.list(vectorStoreId, { signal, timeout: timeoutMs, maxRetries: 2 })),
      attemptBudget,
    ),
    { attempts: 3, delayMs: (attempt) => 1000 * 2 ** (attempt - 1), sleep, onError: (error, attempt) => logRetry(logPath, "list", error, attempt) },
  );
  for await (const file of page) {
    files.push({ id: file.id, status: file.status, attributes: file.attributes });
  }
  console.log(`Listed ${files.length} files.`);
  return files;
}

async function selectCandidates(
  openai: OpenAI,
  listed: { id: string; status: string; attributes?: { [key: string]: string | number | boolean } | null }[],
  pace: () => Promise<void>,
  timeoutMs: number,
  attemptBudget: number,
  logPath: string,
  cacheDir: string,
  vectorStoreId: string,
): Promise<Candidate[]> {
  const selected: Candidate[] = [];
  for (const file of listed) {
    if (file.status !== "completed") continue;
    const documentType = attributeDocumentType(file.attributes);
    const recordDate = attributeRecordDate(file.attributes);
    let filename = readExtractionCache(cacheDir, vectorStoreId, file.id)?.filename
      || readTextCache(cacheDir, vectorStoreId, file.id)?.filename
      || "";
    const needsName = !documentType || !filename || (documentType === "minutes" && recordDate == null);
    if (needsName && !filename) {
      filename = await retrieveFilename(openai, file.id, pace, timeoutMs, attemptBudget, logPath);
    }
    const decision = classifyMinutesCandidate(documentType, filename);
    if (!decision.include) continue;
    if (!filename) filename = await retrieveFilename(openai, file.id, pace, timeoutMs, attemptBudget, logPath);
    selected.push({
      fileId: file.id,
      filename,
      recordDate,
      untagged: decision.untagged,
      year: meetingYear(recordDate, filename),
    });
  }
  return selected;
}

async function retrieveFilename(
  openai: OpenAI,
  fileId: string,
  pace: () => Promise<void>,
  timeoutMs: number,
  attemptBudget: number,
  logPath: string,
): Promise<string> {
  await pace();
  const file = await retryOperation(
    () => withDeadline(
      (signal) => openai.files.retrieve(fileId, { signal, timeout: timeoutMs, maxRetries: 2 }),
      attemptBudget,
    ),
    { attempts: 3, delayMs: (attempt) => 1000 * 2 ** (attempt - 1), sleep, onError: (error, attempt) => logRetry(logPath, fileId, error, attempt) },
  );
  return file.filename || fileId;
}

async function loadMinutesText(context: RunContext, candidate: Candidate): Promise<{ text: string; truncated: boolean }> {
  if (!context.refresh) {
    const cached = readTextCache(context.cacheDir, context.vectorStoreId, candidate.fileId);
    if (cached) return cached;
    const scan = await readScanCache(context.tagCacheDir, context.vectorStoreId, candidate.fileId);
    if (tagCacheTextIsUsable(scan?.text)) {
      const text = (scan?.text ?? "").slice(0, MAX_MINUTES_CHARS);
      const truncated = (scan?.text?.length ?? 0) >= 7_900;
      const entry = {
        filename: candidate.filename || scan?.filename || candidate.fileId,
        text,
        truncated,
        source: "tag-cache" as const,
        recordDate: candidate.recordDate,
        untagged: candidate.untagged,
      };
      writeTextCache(context.cacheDir, context.vectorStoreId, candidate.fileId, entry);
      return entry;
    }
  }
  await context.pace();
  const read = await callWithTimeout(
    context,
    async (signal) => {
      const parts: string[] = [];
      let truncated = false;
      const pages = await context.openai.vectorStores.files.content(
        candidate.fileId,
        { vector_store_id: context.vectorStoreId },
        { signal, timeout: context.timeoutMs, maxRetries: 2 },
      );
      for await (const part of pages) {
        if (part.text) parts.push(part.text);
        if (parts.join("\n").length >= MAX_MINUTES_CHARS) {
          truncated = true;
          break;
        }
      }
      const full = parts.join("\n");
      return { text: full.slice(0, MAX_MINUTES_CHARS), truncated: truncated || full.length > MAX_MINUTES_CHARS };
    },
    candidate.fileId,
  );
  const entry = {
    filename: candidate.filename,
    text: read.text,
    truncated: read.truncated,
    source: "vector-store" as const,
    recordDate: candidate.recordDate,
    untagged: candidate.untagged,
  };
  writeTextCache(context.cacheDir, context.vectorStoreId, candidate.fileId, entry);
  return entry;
}

async function callWithTimeout<T>(
  context: RunContext,
  operation: (signal: AbortSignal) => Promise<T>,
  label: string,
): Promise<T> {
  return retryOperation(
    () => context.pace().then(() => withDeadline(
      (signal) => operation(signal),
      context.attemptBudget,
    )),
    {
      attempts: 3,
      delayMs: (attempt) => 1000 * 2 ** (attempt - 1),
      sleep,
      onError: (error, attempt) => logRetry(context.logPath, label, error, attempt),
    },
  );
}

function promptText(text: string, truncated: boolean): string {
  if (!truncated) return text;
  return `${text}\n\n[The minutes text was truncated. Extract only votes present above.]`;
}

function candidateFields(candidate: Candidate) {
  return {
    fileId: candidate.fileId,
    filename: candidate.filename,
    recordDate: candidate.recordDate,
    untagged: candidate.untagged,
  };
}

async function writeSupabase(input: {
  supabaseUrl: string;
  supabaseKey: string;
  city: string;
  meetings: StoredMeeting[];
  members: VoteMember[];
}) {
  const supabase = createClient(input.supabaseUrl, input.supabaseKey, { auth: { persistSession: false } });
  const municipalityId = await lookupMunicipality(supabase, input.city);
  const urls = await lookupExternalUrls(supabase, input.meetings.map((meeting) => meeting.file_id));
  const dbMembers = await upsertMembers(supabase, municipalityId, input.members);
  const writable = input.meetings.filter((meeting) => meeting.meeting_date);
  const skipped = input.meetings.length - writable.length;
  if (skipped > 0) console.log(`Skipped ${skipped} meetings that have no meeting date.`);

  const meetingRows = writable.map((meeting) => ({
    municipality_id: municipalityId,
    body: meeting.body,
    meeting_date: meeting.meeting_date,
    minutes_status: meeting.minutes_status,
    source_file_id: meeting.file_id,
    source_filename: meeting.filename,
    record_date: meeting.record_date,
    external_url: urls.get(meeting.file_id) ?? null,
    review_status: meeting.review_status,
    review_note: meeting.review_note,
    superseded_by: null,
  }));
  const savedMeetings = await upsertChunks<{ id: string; source_file_id: string }>(
    supabase,
    "meetings",
    meetingRows,
    "municipality_id,source_file_id",
    "id, source_file_id",
  );
  const meetingIdByFile = new Map(savedMeetings.map((row) => [row.source_file_id, row.id]));

  for (const meeting of writable) {
    const meetingId = meetingIdByFile.get(meeting.file_id);
    const winnerId = meeting.superseded_by ? meetingIdByFile.get(meeting.superseded_by) ?? null : null;
    if (!meetingId) continue;
    if (winnerId || meeting.superseded_by) {
      const { error } = await supabase.from("meetings").update({
        superseded_by: winnerId,
        review_status: meeting.review_status,
        review_note: meeting.review_note,
      }).eq("id", meetingId);
      if (error) throw new Error(`Could not update superseded_by for ${meeting.file_id}: ${error.message}`);
    }
    await replaceMotions(supabase, municipalityId, meetingId, meeting, dbMembers);
  }
  console.log(`Upserted ${savedMeetings.length} meetings for ${input.city}.`);
}

async function lookupMunicipality(supabase: SupabaseClient, city: string): Promise<string> {
  const { data, error } = await supabase.from("municipalities").select("id").eq("slug", city).maybeSingle();
  if (error) throw new Error(`Could not read municipalities: ${error.message}`);
  const id = data && typeof data.id === "string" ? data.id : "";
  if (!id) throw new Error(`No municipality with slug ${city}. Seed it before --write.`);
  return id;
}

async function lookupExternalUrls(supabase: SupabaseClient, fileIds: string[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (let index = 0; index < fileIds.length; index += 100) {
    const chunk = fileIds.slice(index, index + 100);
    const { data, error } = await supabase.from("documents").select("openai_file_id, external_url").in("openai_file_id", chunk);
    if (error) {
      console.log(`Document URL lookup failed (${error.message}). Meetings will have a blank external_url.`);
      return urls;
    }
    for (const row of data ?? []) {
      if (typeof row.openai_file_id === "string" && typeof row.external_url === "string" && row.external_url) {
        urls.set(row.openai_file_id, row.external_url);
      }
    }
  }
  return urls;
}

async function upsertMembers(supabase: SupabaseClient, municipalityId: string, members: VoteMember[]): Promise<VoteMember[]> {
  if (members.length === 0) return [];
  const rows = members.map((member) => ({
    municipality_id: municipalityId,
    body: member.body,
    canonical_name: member.canonical_name,
    role: member.role,
    aliases: member.aliases,
  }));
  await upsertChunks(supabase, "vote_members", rows, "municipality_id,body,canonical_name", "id");
  const { data, error } = await supabase
    .from("vote_members")
    .select("id, body, canonical_name, role, aliases")
    .eq("municipality_id", municipalityId);
  if (error) throw new Error(`Could not read vote_members: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: String(row.id),
    body: String(row.body),
    canonical_name: String(row.canonical_name),
    role: typeof row.role === "string" ? row.role : null,
    aliases: Array.isArray(row.aliases) ? row.aliases.filter((alias): alias is string => typeof alias === "string") : [],
  }));
}

async function replaceMotions(
  supabase: SupabaseClient,
  municipalityId: string,
  meetingId: string,
  meeting: StoredMeeting,
  dbMembers: VoteMember[],
) {
  const roster = membersForBody(dbMembers, meeting.body);
  const { data: existing, error: existingError } = await supabase.from("motions").select("id, item_key").eq("meeting_id", meetingId);
  if (existingError) throw new Error(`Could not read motions for ${meeting.file_id}: ${existingError.message}`);
  const nextKeys = new Set(meeting.motions.map((motion) => motion.item_key));
  const staleIds = (existing ?? [])
    .filter((row) => typeof row.id === "string" && typeof row.item_key === "string" && !nextKeys.has(row.item_key))
    .map((row) => String(row.id));
  for (let index = 0; index < staleIds.length; index += 100) {
    const { error } = await supabase.from("motions").delete().in("id", staleIds.slice(index, index + 100));
    if (error) throw new Error(`Could not delete stale motions: ${error.message}`);
  }

  const motionRows = meeting.motions.map((motion) => ({
    meeting_id: meetingId,
    municipality_id: municipalityId,
    item_key: motion.item_key,
    item_number: motion.item_number,
    title: motion.title,
    motion_text: motion.motion_text,
    mover_raw: motion.mover_raw,
    seconder_raw: motion.seconder_raw,
    mover_member_id: motion.mover_raw ? matchMemberName(motion.mover_raw, roster).member_id : null,
    seconder_member_id: motion.seconder_raw ? matchMemberName(motion.seconder_raw, roster).member_id : null,
    result: motion.result,
    tally_aye: motion.tally_aye,
    tally_nay: motion.tally_nay,
    tally_abstain: motion.tally_abstain,
    tally_absent: motion.tally_absent,
    tally_recused: motion.tally_recused,
    tally_text: motion.tally_text,
    source_file_id: meeting.file_id,
    source_page: motion.source_page,
    validation_status: motion.validation_status,
    validation_note: motion.validation_note,
  }));
  const saved = await upsertChunks<{ id: string; item_key: string }>(
    supabase,
    "motions",
    motionRows,
    "meeting_id,item_key",
    "id, item_key",
  );
  const motionIdByKey = new Map(saved.map((row) => [row.item_key, row.id]));
  const motionIds = saved.map((row) => row.id);
  for (let index = 0; index < motionIds.length; index += 100) {
    const { error } = await supabase.from("member_votes").delete().in("motion_id", motionIds.slice(index, index + 100));
    if (error) throw new Error(`Could not replace member votes: ${error.message}`);
  }
  const voteRows = meeting.motions.flatMap((motion) => {
    const motionId = motionIdByKey.get(motion.item_key);
    if (!motionId) return [];
    return motion.votes.map((vote) => ({
      motion_id: motionId,
      member_id: matchMemberName(vote.raw_name, roster).member_id,
      raw_name: vote.raw_name,
      choice: vote.choice,
    }));
  });
  for (let index = 0; index < voteRows.length; index += 200) {
    const { error } = await supabase.from("member_votes").insert(voteRows.slice(index, index + 200));
    if (error) throw new Error(`Could not insert member votes: ${error.message}`);
  }
}

async function upsertChunks<T>(
  supabase: SupabaseClient,
  table: "meetings" | "motions" | "vote_members",
  rows: Record<string, unknown>[],
  onConflict: string,
  selection: string,
): Promise<T[]> {
  const saved: T[] = [];
  for (let index = 0; index < rows.length; index += 100) {
    const chunk = rows.slice(index, index + 100);
    if (chunk.length === 0) continue;
    const { data, error } = await supabase.from(table).upsert(chunk, { onConflict }).select(selection);
    if (error) throw new Error(`${table} upsert failed: ${error.message}`);
    saved.push(...(data as T[] ?? []));
  }
  return saved;
}

function loadMembers(city: string): VoteMember[] {
  if (values.aliases) {
    const parsed = JSON.parse(readFileSync(values.aliases, "utf8")) as SeedMember[];
    if (!Array.isArray(parsed)) throw new Error("--aliases must be a JSON array.");
    return membersFromSeed(parsed);
  }
  if (values["no-seed"]) return [];
  if (city === "oak-park-il") return oakParkSeedMembers();
  return [];
}

function cachePaths(cacheDir: string, vectorStoreId: string, fileId: string) {
  assertSafeId("vector store id", vectorStoreId);
  assertSafeId("file id", fileId);
  const directory = path.join(cacheDir, vectorStoreId);
  return {
    directory,
    text: path.join(directory, `${fileId}.text.json`),
    extraction: path.join(directory, `${fileId}.json`),
  };
}

function readExtractionCache(cacheDir: string, vectorStoreId: string, fileId: string): StoredMeeting | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePaths(cacheDir, vectorStoreId, fileId).extraction, "utf8")) as unknown;
    return isStoredMeeting(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeExtractionCache(cacheDir: string, vectorStoreId: string, meeting: StoredMeeting) {
  const paths = cachePaths(cacheDir, vectorStoreId, meeting.file_id);
  makeCacheDir(paths.directory);
  writeFileSync(paths.extraction, JSON.stringify(meeting));
}

function readTextCache(cacheDir: string, vectorStoreId: string, fileId: string): TextCache | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePaths(cacheDir, vectorStoreId, fileId).text, "utf8")) as Partial<TextCache>;
    if (typeof parsed.text !== "string" || typeof parsed.filename !== "string" || typeof parsed.truncated !== "boolean") return null;
    if (parsed.source !== "vector-store" && parsed.source !== "tag-cache") return null;
    return {
      filename: parsed.filename,
      text: parsed.text,
      truncated: parsed.truncated,
      source: parsed.source,
      recordDate: typeof parsed.recordDate === "number" ? parsed.recordDate : null,
      untagged: parsed.untagged === true,
    };
  } catch {
    return null;
  }
}

function writeTextCache(cacheDir: string, vectorStoreId: string, fileId: string, entry: TextCache) {
  const paths = cachePaths(cacheDir, vectorStoreId, fileId);
  makeCacheDir(paths.directory);
  writeFileSync(paths.text, JSON.stringify(entry));
}

function readBatchState(cacheDir: string, vectorStoreId: string): BatchState | null {
  try {
    assertSafeId("vector store id", vectorStoreId);
    const parsed = JSON.parse(readFileSync(path.join(cacheDir, vectorStoreId, "batch.json"), "utf8")) as Partial<BatchState>;
    if (parsed.vectorStoreId !== vectorStoreId) return null;
    if (parsed.activeBatchId != null && typeof parsed.activeBatchId !== "string") return null;
    return {
      vectorStoreId,
      activeBatchId: parsed.activeBatchId ?? null,
      submittedFileIds: Array.isArray(parsed.submittedFileIds) ? parsed.submittedFileIds.filter((id): id is string => typeof id === "string") : [],
    };
  } catch {
    return null;
  }
}

function writeBatchState(cacheDir: string, state: BatchState) {
  assertSafeId("vector store id", state.vectorStoreId);
  const directory = path.join(cacheDir, state.vectorStoreId);
  makeCacheDir(directory);
  writeFileSync(path.join(directory, "batch.json"), JSON.stringify(state));
}

function makeCacheDir(directory: string) {
  mkdirSync(directory, { recursive: true });
}

function assertSafeId(label: string, value: string) {
  if (!/^[\w-]+$/.test(value)) throw new Error(`The ${label} has unexpected characters.`);
}

function createPacer(delayMs: number) {
  let last = 0;
  return async function pace() {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function logRetry(logPath: string, label: string, error: unknown, attempt: number) {
  if (attempt < 3) logChange(logPath, `retry ${attempt}/3 ${label} ${errorMessage(error)}`);
}

function logChange(logPath: string, message: string) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  appendFileSync(logPath, `${line}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
