import { describe, expect, it } from "vitest";
import { MAX_DOCUMENT_BYTES, safeStorageFilename, validateDocumentInput } from "./document-validation";

const valid = { title: "Council minutes", documentType: "minutes", filename: "minutes.pdf", size: 1024 };

describe("document validation", () => {
  it("accepts a supported document", () => expect(validateDocumentInput(valid)).toBeNull());
  it("rejects unsupported extensions", () => expect(validateDocumentInput({ ...valid, filename: "script.exe" })).toContain("not supported"));
  it("rejects oversized files", () => expect(validateDocumentInput({ ...valid, size: MAX_DOCUMENT_BYTES + 1 })).toContain("20 MB"));
  it("creates safe storage filenames", () => expect(safeStorageFilename("Council Minutes (Final).pdf")).toBe("Council-Minutes-Final-.pdf"));
});
