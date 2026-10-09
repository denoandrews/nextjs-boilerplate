export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_BATCH_DOCUMENTS = 500;

const ALLOWED_EXTENSIONS = new Set(["pdf", "txt", "md", "html", "doc", "docx"]);
const ALLOWED_DOCUMENT_TYPES = new Set([
  "ordinance",
  "resolution",
  "minutes",
  "agenda",
  "policy",
  "law",
  "news",
  "other",
]);

export function validateDocumentInput(input: {
  title: string;
  documentType: string;
  filename: string;
  size: number;
}) {
  const title = input.title.trim();
  const extension = input.filename.split(".").pop()?.toLowerCase();
  if (!title || title.length > 200) return "Provide a title of 200 characters or fewer.";
  if (!ALLOWED_DOCUMENT_TYPES.has(input.documentType)) return "Select a valid document type.";
  if (!extension || !ALLOWED_EXTENSIONS.has(extension)) return "This file type is not supported.";
  if (input.size <= 0 || input.size > MAX_DOCUMENT_BYTES) return "Files must be between 1 byte and 20 MB.";
  return null;
}

export function validateDocumentBatchCount(count: number) {
  if (!Number.isInteger(count) || count < 1) return "Select at least one document.";
  if (count > MAX_BATCH_DOCUMENTS) {
    return `Select no more than ${MAX_BATCH_DOCUMENTS} documents at a time.`;
  }
  return null;
}

export function documentTitleFromFilename(filename: string) {
  const lastDot = filename.lastIndexOf(".");
  const withoutExtension = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  const title = withoutExtension.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  return (title || "Untitled document").slice(0, 200).trim();
}

export function safeStorageFilename(filename: string) {
  const cleaned = filename
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-150);
  return cleaned || "document";
}
