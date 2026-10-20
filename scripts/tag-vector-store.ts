/**
 * Propose vector-store file attributes, or apply a reviewed CSV.
 *
 * Dry run is the default and does not write to OpenAI.
 * --apply reads a reviewed CSV and calls vectorStores.files.update (attributes only).
 * This script never uploads or deletes files, and the chat route does not use it.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

import {
  applyAttemptBudgetMs,
  classifyApplyRow,
  parseApplyLog,
  retryOperation,
  withDeadline,
} from "../lib/vector-store-apply-log";
import { readScanCache, writeScanCache, type CachedScan } from "../lib/vector-store-tag-cache";
import { extractOpeningPdfText } from "../lib/vector-store-pdf";
import {
  attributesForRow,
  decodeFileContent,
  filenameHasIsoDate,
  finalizeProposals,
  parseTagsCsv,
  proposeTag,
  tagsToCsv,
  type TagProposal,
} from "../lib/vector-store-tags";

type ListedFile = { id: string; status: string };
type StoredDocument = { externalUrl: string | null; title: string | null; documentType: string | null };
type ContentRead = { text: string | null; method: CachedScan["contentMethod"]; note: string };

const { values } = parseArgs({
  options: {
    help: { type: "boolean", default: false },
    apply: { type: "string" },
    "api-key": { type: "string" },
    "vector-store": { type: "string" },
    city: { type: "string" },
    out: { type: "string" },
    cache: { type: "string" },
    "delay-ms": { type: "string" },
    "timeout-ms": { type: "string" },
    resume: { type: "string" },
    "retry-failed": { type: "string" },
    limit: { type: "string" },
    refresh: { type: "boolean", default: false },
    "supabase-url": { type: "string" },
    "supabase-key": { type: "string" },
  },
  strict: true,
});

function printHelp() {
  console.log(`Usage:
  npm run tag-vector-store -- --out oak-park-tags.csv
  npm run tag-vector-store -- --apply oak-park-tags.csv
  npm run tag-vector-store -- --apply oak-park-tags.csv --resume oak-park-tags.csv.apply.log
  npm run tag-vector-store -- --apply oak-park-tags.csv --retry-failed oak-park-tags.csv.apply.log

Dry run is the default and writes nothing to OpenAI.
Required: OPENAI_API_KEY and VECTOR_STORE_ID (or --api-key and --vector-store).
Required: MUNICIPALITY_SLUG or --city.
Optional: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, --delay-ms, --timeout-ms, --cache, --refresh, --limit.
--resume and --retry-failed are only used with --apply.`);
}

async function main() {
  if (values.help) {
    printHelp();
    return;
  }
  const apiKey = values["api-key"] || process.env.OPENAI_API_KEY || "";
  const vectorStoreId = values["vector-store"] || process.env.VECTOR_STORE_ID || process.env.VECTOR_STORE_IDS?.split(",")[0]?.trim() || "";
  const city = (values.city || process.env.MUNICIPALITY_SLUG || process.env.CITY || "").trim();
  const delayMs = Number(values["delay-ms"] ?? "200");
  const timeoutMs = Number(values["timeout-ms"] ?? "30000");
  const limit = values.limit == null ? null : Number(values.limit);
  if ((values.resume || values["retry-failed"]) && !values.apply) {
    throw new Error("--resume and --retry-failed are used with --apply.");
  }
  if (values.resume && values["retry-failed"]) throw new Error("Pass only one of --resume or --retry-failed.");
  if (!apiKey) throw new Error("Set OPENAI_API_KEY or pass --api-key.");
  if (!vectorStoreId) throw new Error("Set VECTOR_STORE_ID or pass --vector-store.");
  if (!/^[\w-]+$/.test(vectorStoreId)) throw new Error("The vector store id has unexpected characters.");
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("--delay-ms must be a number that is zero or greater.");
  if (limit != null && (!Number.isInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("--timeout-ms must be a positive integer.");
  if (!city || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(city)) {
    throw new Error("Set MUNICIPALITY_SLUG or pass --city, using a lowercase slug such as oak-park-il.");
  }

  const openai = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 2 });
  const pace = createPacer(delayMs);

  if (values.apply) {
    await applyReviewedCsv({
      openai,
      vectorStoreId,
      csvPath: values.apply,
      pace,
      timeoutMs,
      resumeLog: values.resume,
      retryFailedLog: values["retry-failed"],
    });
    return;
  }

  const cacheDir = values.cache || ".vector-store-tag-cache";
  const outPath = values.out || "vector-store-tags.csv";
  await dryRun({
    openai,
    vectorStoreId,
    city,
    cacheDir,
    outPath,
    refresh: values.refresh,
    limit,
    pace,
    supabaseUrl: values["supabase-url"] || process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    supabaseKey: values["supabase-key"] || process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  });
}

async function dryRun(input: {
  openai: OpenAI;
  vectorStoreId: string;
  city: string;
  cacheDir: string;
  outPath: string;
  refresh: boolean;
  limit: number | null;
  pace: () => Promise<void>;
  supabaseUrl: string;
  supabaseKey: string;
}) {
  console.log(`Dry run for ${input.city} in ${input.vectorStoreId}. No OpenAI files will be updated.`);
  const listed = await listVectorStoreFiles(input.openai, input.vectorStoreId, input.pace);
  const files = input.limit == null ? listed : listed.slice(0, input.limit);
  if (input.limit != null) console.log(`Stopping after ${files.length} of ${listed.length} files because --limit was set.`);
  const stored = await loadStoredDocuments(files.map((file) => file.id), input.supabaseUrl, input.supabaseKey);

  const proposals: TagProposal[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const cached = input.refresh ? null : await readScanCache(input.cacheDir, input.vectorStoreId, file.id);
    const document = stored.get(file.id);
    try {
      let filename = cached?.filename ?? "";
      if (!filename) filename = await retrieveFilename(input.openai, file.id, input.pace);

      let text: string | null = null;
      let contentNote = "";
      if (!filenameHasIsoDate(filename)) {
        if (cached?.fetchedContent && cached.filename === filename && cached.text != null) {
          text = cached.text;
          contentNote = contentNoteFor(cached.contentMethod);
        } else {
          const read = await readDocumentText(input.openai, input.vectorStoreId, file.id, input.pace);
          text = read.text;
          contentNote = read.note;
          await writeScanCache(input.cacheDir, input.vectorStoreId, file.id, {
            filename,
            text,
            contentMethod: read.method,
            fetchedContent: true,
          });
        }
      } else if (!cached) {
        await writeScanCache(input.cacheDir, input.vectorStoreId, file.id, {
          filename,
          text: null,
          contentMethod: "none",
          fetchedContent: false,
        });
      }

      proposals.push(proposeTag({
        fileId: file.id,
        filename,
        city: input.city,
        text,
        contentNote,
        externalUrl: document?.externalUrl,
        storedTitle: document?.title,
        storedType: document?.documentType,
        vectorStatus: file.status,
      }));
    } catch (error) {
      proposals.push(proposeTag({
        fileId: file.id,
        filename: cached?.filename || file.id,
        city: input.city,
        text: null,
        contentNote: `This file could not be scanned (${error instanceof Error ? error.message : String(error)}).`,
        externalUrl: document?.externalUrl,
        storedTitle: document?.title,
        storedType: document?.documentType,
        vectorStatus: file.status,
      }));
    }
    if ((index + 1) % 25 === 0 || index === files.length - 1) {
      console.log(`Scanned ${index + 1} of ${files.length}.`);
    }
  }

  const finalProposals = finalizeProposals(proposals);
  writeFileSync(input.outPath, tagsToCsv(finalProposals));
  const review = finalProposals.filter((row) => row.needs_review === "yes").length;
  const bySource = { filename: 0, content: 0, none: 0 };
  for (const row of finalProposals) bySource[row.date_source] += 1;
  console.log(`Wrote ${finalProposals.length} rows to ${input.outPath}.`);
  console.log(`needs_review=no: ${finalProposals.length - review}. needs_review=yes: ${review}.`);
  console.log(`date_source filename: ${bySource.filename}. content: ${bySource.content}. none: ${bySource.none}.`);
  console.log("Dry run finished. Nothing was written to OpenAI.");
}

async function applyReviewedCsv(input: {
  openai: OpenAI;
  vectorStoreId: string;
  csvPath: string;
  pace: () => Promise<void>;
  timeoutMs: number;
  resumeLog?: string;
  retryFailedLog?: string;
}) {
  const rows = parseTagsCsv(readFileSync(input.csvPath, "utf8"));
  const logPath = `${input.csvPath}.apply.log`;
  const resumeUpdated = input.resumeLog ? parseApplyLog(readFileSync(input.resumeLog, "utf8")).updated : undefined;
  const retryFailed = input.retryFailedLog ? parseApplyLog(readFileSync(input.retryFailedLog, "utf8")).failed : undefined;
  const seen = new Set<string>();
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const attemptBudget = applyAttemptBudgetMs(input.timeoutMs, 2);
  console.log(`Applying reviewed rows in ${input.csvPath} to ${input.vectorStoreId}. Attributes only.`);
  console.log(`Each request times out after ${input.timeoutMs}ms, with 2 client retries, and the row is abandoned after 3 attempts.`);
  if (resumeUpdated) console.log(`Resume will skip ${resumeUpdated.size} file ids already logged as updated.`);
  if (retryFailed) console.log(`Retry will reapply ${retryFailed.size} file ids whose latest log line is failed.`);

  for (const row of rows) {
    if (seen.has(row.file_id)) {
      skipped += 1;
      logChange(logPath, `skipped ${row.file_id} duplicate file_id`);
      continue;
    }
    seen.add(row.file_id);
    const selection = classifyApplyRow(row.file_id, { resumeUpdated, retryFailed });
    if (selection.action === "skip") {
      skipped += 1;
      if (selection.reason === "already updated") logChange(logPath, `skipped ${row.file_id} already updated`);
      continue;
    }
    const decision = attributesForRow(row);
    if (decision.action === "skip") {
      skipped += 1;
      logChange(logPath, `skipped ${row.file_id} ${decision.reason}`);
      continue;
    }
    try {
      console.log(`${new Date().toISOString()} updating ${row.file_id}`);
      await retryOperation(
        () => {
          return input.pace().then(() => withDeadline(
            (signal) => input.openai.vectorStores.files.update(row.file_id, {
              vector_store_id: input.vectorStoreId,
              attributes: decision.attributes,
            }, { signal, timeout: input.timeoutMs, maxRetries: 2 }),
            attemptBudget,
          ));
        },
        {
          attempts: 3,
          delayMs: (failedAttempt) => 1000 * 2 ** (failedAttempt - 1),
          sleep,
          onError: (error, failedAttempt) => {
            if (failedAttempt < 3) {
              logChange(logPath, `retry ${failedAttempt}/3 ${row.file_id} ${errorMessage(error)}`);
            }
          },
        },
      );
      updated += 1;
      logChange(logPath, `updated ${row.file_id} ${JSON.stringify(decision.attributes)}`);
    } catch (error) {
      failed += 1;
      logChange(logPath, `failed ${row.file_id} ${errorMessage(error)}`);
    }
  }

  console.log(`Updated ${updated}. Skipped ${skipped}. Failed ${failed}. Log: ${logPath}`);
  if (failed > 0) process.exitCode = 1;
}

async function listVectorStoreFiles(openai: OpenAI, vectorStoreId: string, pace: () => Promise<void>): Promise<ListedFile[]> {
  const files: ListedFile[] = [];
  await pace();
  for await (const file of await withBackoff(() => Promise.resolve(openai.vectorStores.files.list(vectorStoreId)))) {
    files.push({ id: file.id, status: file.status });
  }
  console.log(`Listed ${files.length} files.`);
  return files;
}

async function retrieveFilename(openai: OpenAI, fileId: string, pace: () => Promise<void>): Promise<string> {
  await pace();
  const file = await withBackoff(() => openai.files.retrieve(fileId));
  return file.filename || "";
}

async function readDocumentText(
  openai: OpenAI,
  vectorStoreId: string,
  fileId: string,
  pace: () => Promise<void>,
): Promise<ContentRead> {
  let fileNote = "";
  try {
    await pace();
    const response = await fileContentResponse(openai, fileId);
    if (response.status === 404 || response.status === 400 || response.status === 403) {
      fileNote = `file content was not available (HTTP ${response.status})`;
    } else if (!response.ok) {
      fileNote = `file content returned HTTP ${response.status}`;
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      const decoded = decodeFileContent(bytes, response.headers.get("content-type"));
      if (decoded.kind === "text") {
        return { text: decoded.text.slice(0, 20000), method: "file", note: "Date text read from the file content endpoint." };
      }
      if (decoded.kind === "pdf") {
        try {
          const text = await extractOpeningPdfText(decoded.bytes);
          if (text.trim()) {
            return { text, method: "pdf", note: "Date text parsed from the PDF downloaded from the file content endpoint." };
          }
          fileNote = "the PDF had no extractable text in the first pages";
        } catch (error) {
          fileNote = `PDF parsing failed (${errorMessage(error)})`;
        }
      } else {
        fileNote = decoded.note;
      }
    }
  } catch (error) {
    fileNote = errorMessage(error);
  }

  try {
    await pace();
    const parts: string[] = [];
    const pages = await withBackoff(() => Promise.resolve(openai.vectorStores.files.content(fileId, { vector_store_id: vectorStoreId })));
    for await (const part of pages) {
      if (part.text) parts.push(part.text);
      if (parts.join("\n").length >= 8000) break;
    }
    const text = parts.join("\n").slice(0, 20000);
    if (text.trim()) {
      return {
        text,
        method: "vector-store",
        note: `Date text read from the vector store content endpoint after the file endpoint did not yield text (${fileNote}).`,
      };
    }
    return { text: "", method: "none", note: `No document text was found (${fileNote}).` };
  } catch (error) {
    return { text: null, method: "none", note: `Document text could not be read (${fileNote}; vector store content: ${errorMessage(error)}).` };
  }
}

async function fileContentResponse(openai: OpenAI, fileId: string): Promise<Response> {
  let response: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await openai.files.content(fileId);
    if (response.status !== 429 || attempt === 3) return response;
    await sleep(1000 * 2 ** attempt);
  }
  return response as Response;
}

async function loadStoredDocuments(fileIds: string[], supabaseUrl: string, supabaseKey: string): Promise<Map<string, StoredDocument>> {
  const stored = new Map<string, StoredDocument>();
  if (!supabaseUrl || !supabaseKey) {
    console.log("Supabase credentials were not set. source_url will not be joined from documents.external_url.");
    return stored;
  }
  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });
  for (let index = 0; index < fileIds.length; index += 100) {
    const batch = fileIds.slice(index, index + 100);
    const { data, error } = await supabase
      .from("documents")
      .select("openai_file_id, external_url, title, document_type")
      .in("openai_file_id", batch);
    if (error) {
      console.log(`Supabase lookup failed (${error.message}). Continuing without stored URLs.`);
      return stored;
    }
    for (const row of data ?? []) {
      if (typeof row.openai_file_id !== "string") continue;
      stored.set(row.openai_file_id, {
        externalUrl: typeof row.external_url === "string" ? row.external_url : null,
        title: typeof row.title === "string" ? row.title : null,
        documentType: typeof row.document_type === "string" ? row.document_type : null,
      });
    }
  }
  console.log(`Joined ${stored.size} Supabase document rows.`);
  return stored;
}

function contentNoteFor(method: CachedScan["contentMethod"]): string {
  if (method === "file") return "Date text read from the cached file content.";
  if (method === "pdf") return "Date text parsed from the cached PDF.";
  if (method === "vector-store") return "Date text read from the cached vector store content.";
  return "Cached scan found no document text.";
}

function createPacer(delayMs: number) {
  let last = 0;
  return async function pace() {
    const wait = last + delayMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}

async function withBackoff<T>(operation: () => Promise<T>): Promise<T> {
  let wait = 1000;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
      if (status !== 429 || attempt === 3) throw error;
      await sleep(wait);
      wait *= 2;
    }
  }
  throw new Error("OpenAI request failed after retries.");
}

function logChange(logPath: string, message: string) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  appendFileSync(logPath, `${line}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
