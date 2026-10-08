import { describe, expect, it } from "vitest";
import {
  MAX_BATCH_DOCUMENTS,
  MAX_DOCUMENT_BYTES,
  documentTitleFromFilename,
  safeStorageFilename,
  validateDocumentBatchCount,
  validateDocumentInput,
} from "./document-validation";

const valid = { title: "Council minutes", documentType: "minutes", filename: "minutes.pdf", size: 1024 };

describe("document validation", () => {
  it("accepts a supported document", () => expect(validateDocumentInput(valid)).toBeNull());
  it("rejects unsupported extensions", () => expect(validateDocumentInput({ ...valid, filename: "script.exe" })).toContain("not supported"));
  it("rejects oversized files", () => expect(validateDocumentInput({ ...valid, size: MAX_DOCUMENT_BYTES + 1 })).toContain("20 MB"));
  it("creates safe storage filenames", () => expect(safeStorageFilename("Council Minutes (Final).pdf")).toBe("Council-Minutes-Final-.pdf"));
  it("derives an editable title from a filename", () => {
    expect(documentTitleFromFilename("Resolution_26-83_Final_Disposal.pdf")).toBe("Resolution 26-83 Final Disposal");
  });
  it("accepts a meeting-sized document batch", () => expect(validateDocumentBatchCount(20)).toBeNull());
  it("rejects an oversized document batch", () => {
    expect(validateDocumentBatchCount(MAX_BATCH_DOCUMENTS + 1)).toContain(String(MAX_BATCH_DOCUMENTS));
  });
});
