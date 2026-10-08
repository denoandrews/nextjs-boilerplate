"use client";

import { ChangeEvent, FormEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  MAX_BATCH_DOCUMENTS,
  documentTitleFromFilename,
  validateDocumentBatchCount,
  validateDocumentInput,
} from "@/lib/document-validation";

const DOCUMENT_TYPES = [
  ["ordinance", "Ordinance"],
  ["resolution", "Resolution"],
  ["minutes", "Minutes"],
  ["agenda", "Agenda"],
  ["policy", "Policy"],
  ["law", "County or state law"],
  ["news", "Trusted news"],
  ["other", "Other public record"],
] as const;

type UploadStatus = "pending" | "uploading" | "published" | "draft" | "error";

type UploadItem = {
  id: string;
  file: File;
  title: string;
  documentType: string;
  status: UploadStatus;
  message: string;
};

type UploadResponse = {
  error?: string;
  status?: string;
  warning?: string;
};

function formatFileSize(size: number) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function UploadForm({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<UploadItem[]>([]);
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const uploadableCount = useMemo(
    () => items.filter((item) => item.status === "pending").length,
    [items]
  );

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const batchError = validateDocumentBatchCount(files.length);
    if (batchError) {
      setItems([]);
      setSummary(batchError);
      event.target.value = "";
      return;
    }
    const selectedItems = files.map((file) => {
      const title = documentTitleFromFilename(file.name);
      const validationError = validateDocumentInput({ title, documentType: "other", filename: file.name, size: file.size });
      return {
        id: crypto.randomUUID(),
        file,
        title,
        documentType: "other",
        status: validationError ? "error" as const : "pending" as const,
        message: validationError || "Ready",
      };
    });
    setItems(selectedItems);
    const rejected = selectedItems.filter((item) => item.status === "error").length;
    setSummary(
      rejected
        ? `${files.length} documents selected; ${rejected} cannot be uploaded. Review the individual results below.`
        : `${files.length} document${files.length === 1 ? "" : "s"} selected. Review the titles and types before uploading.`
    );
  }

  function updateItem(id: string, update: Partial<Pick<UploadItem, "title" | "documentType" | "status" | "message">>) {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...update } : item)));
  }

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
    setSummary("");
  }

  function clearItems() {
    setItems([]);
    setSummary("");
    if (fileInput.current) fileInput.current.value = "";
  }

  async function uploadItem(item: UploadItem): Promise<UploadStatus> {
    updateItem(item.id, { status: "uploading", message: "Uploading and indexing…" });
    const form = new FormData();
    form.set("title", item.title.trim());
    form.set("documentType", item.documentType);
    form.set("file", item.file);

    try {
      const response = await fetch("/api/admin/documents", { method: "POST", body: form });
      const result = (await response.json().catch(() => ({}))) as UploadResponse;
      if (!response.ok) {
        updateItem(item.id, { status: "error", message: result.error || "Upload failed." });
        return "error";
      }
      if (result.status === "published") {
        updateItem(item.id, { status: "published", message: "Uploaded and indexed" });
        return "published";
      }
      updateItem(item.id, { status: "draft", message: result.warning || "Uploaded as a draft" });
      return "draft";
    } catch {
      updateItem(item.id, { status: "error", message: "Upload failed. Check the connection and try this file again." });
      return "error";
    }
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const batchError = validateDocumentBatchCount(items.length);
    if (batchError) {
      setSummary(batchError);
      return;
    }
    if (items.some((item) => !item.title.trim())) {
      setSummary("Every document needs a title before the batch can be uploaded.");
      return;
    }

    const queue = items.filter((item) => item.status === "pending");
    if (!queue.length) {
      setSummary("This batch has already been uploaded. Clear the list to start another batch.");
      return;
    }
    setBusy(true);
    setSummary(`Uploading ${queue.length} document${queue.length === 1 ? "" : "s"}…`);
    const results: UploadStatus[] = new Array(queue.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < queue.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await uploadItem(queue[index]);
      }
    }

    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, () => worker()));
    setBusy(false);
    const published = results.filter((status) => status === "published").length;
    const drafts = results.filter((status) => status === "draft").length;
    const errors = results.filter((status) => status === "error").length;
    const parts = [
      published ? `${published} indexed` : "",
      drafts ? `${drafts} saved as draft${drafts === 1 ? "" : "s"}` : "",
      errors ? `${errors} failed` : "",
    ].filter(Boolean);
    setSummary(`Batch complete: ${parts.join(", ")}.`);
    router.refresh();
  }

  if (!canEdit) return <p>Your account has read-only access.</p>;

  return (
    <form className="admin-form upload-form" onSubmit={upload}>
      <label htmlFor="files">Select documents</label>
      <input
        ref={fileInput}
        id="files"
        type="file"
        accept=".pdf,.txt,.md,.html,.doc,.docx"
        multiple
        disabled={busy}
        onChange={selectFiles}
      />
      <p className="form-help">Choose up to {MAX_BATCH_DOCUMENTS} files. Each file may be up to 20 MB.</p>
      {items.length ? (
        <>
          <div className="table-wrap batch-table-wrap">
            <table className="batch-table">
              <thead><tr><th>File</th><th>Document title</th><th>Type</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.file.name}</strong><span className="file-size">{formatFileSize(item.file.size)}</span></td>
                    <td><input aria-label={`Title for ${item.file.name}`} value={item.title} maxLength={200} required disabled={busy || item.status !== "pending"} onChange={(event) => updateItem(item.id, { title: event.target.value })} /></td>
                    <td>
                      <select aria-label={`Document type for ${item.file.name}`} value={item.documentType} disabled={busy || item.status !== "pending"} onChange={(event) => updateItem(item.id, { documentType: event.target.value })}>
                        {DOCUMENT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </td>
                    <td><span className={`status-badge status-${item.status}`}>{item.message}</span></td>
                    <td><button className="button-link" type="button" disabled={busy} onClick={() => removeItem(item.id)} aria-label={`Remove ${item.file.name}`}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="form-actions">
            <button type="submit" disabled={busy || uploadableCount === 0}>{busy ? "Uploading and indexing…" : `Upload and index ${uploadableCount} document${uploadableCount === 1 ? "" : "s"}`}</button>
            <button className="button-secondary" type="button" disabled={busy} onClick={clearItems}>Clear list</button>
          </div>
        </>
      ) : null}
      {summary ? <p role="status" className={summary.includes("failed") ? "form-error" : undefined}>{summary}</p> : null}
    </form>
  );
}
