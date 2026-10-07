export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

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

export function safeStorageFilename(filename: string) {
  const cleaned = filename
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-150);
  return cleaned || "document";
}
