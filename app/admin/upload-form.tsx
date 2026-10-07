"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function UploadForm({ canEdit }: { canEdit: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    const response = await fetch("/api/admin/documents", {
      method: "POST",
      body: new FormData(event.currentTarget),
    });
    const result = (await response.json()) as { error?: string; status?: string; warning?: string };
    setBusy(false);
    if (!response.ok) {
      setStatus(result.error || "Upload failed.");
      return;
    }
    event.currentTarget.reset();
    setStatus(
      result.status === "published"
        ? "Document uploaded and indexed."
        : result.warning || "Document uploaded as a draft."
    );
    router.refresh();
  }

  if (!canEdit) return <p>Your account has read-only access.</p>;

  return (
    <form className="admin-form upload-form" onSubmit={upload}>
      <label htmlFor="title">Document title</label>
      <input id="title" name="title" required maxLength={200} />
      <label htmlFor="documentType">Document type</label>
      <select id="documentType" name="documentType" defaultValue="other">
        <option value="ordinance">Ordinance</option>
        <option value="resolution">Resolution</option>
        <option value="minutes">Minutes</option>
        <option value="agenda">Agenda</option>
        <option value="policy">Policy</option>
        <option value="law">County or state law</option>
        <option value="news">Trusted news</option>
        <option value="other">Other public record</option>
      </select>
      <label htmlFor="file">File</label>
      <input id="file" name="file" type="file" accept=".pdf,.txt,.md,.html,.doc,.docx" required />
      <button type="submit" disabled={busy}>{busy ? "Uploading…" : "Upload and index"}</button>
      {status ? <p role="status">{status}</p> : null}
    </form>
  );
}
