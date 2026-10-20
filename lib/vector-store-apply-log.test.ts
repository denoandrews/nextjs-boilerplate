import { describe, expect, it } from "vitest";

import {
  applyAttemptBudgetMs,
  classifyApplyRow,
  parseApplyLog,
  retryOperation,
  withDeadline,
} from "./vector-store-apply-log";

const APPLY_LOG = `
2026-10-20T13:00:00.000Z updated file-done {"city":"oak-park-il","document_type":"minutes"}
2026-10-20T13:05:00.000Z failed file-timeout Request timed out.
2026-10-20T13:06:00.000Z failed file-then-ok Request timed out.
2026-10-20T13:07:00.000Z updated file-then-ok {"city":"oak-park-il"}
2026-10-20T13:08:00.000Z skipped file-review needs_review
2026-10-20T14:00:00.000Z updated file-again {"document_type":"agenda"}
2026-10-20T15:00:00.000Z failed file-again Request timed out.
`.trim();

describe("apply log parsing", () => {
  it("collects updated ids and only the failures that were not updated afterward", () => {
    const parsed = parseApplyLog(APPLY_LOG);
    expect([...parsed.updated].sort()).toEqual(["file-again", "file-done", "file-then-ok"]);
    expect([...parsed.failed]).toEqual(["file-timeout", "file-again"]);
    expect(parsed.failed.has("file-then-ok")).toBe(false);
    expect(parsed.updated.has("file-review")).toBe(false);
  });

  it("resume skips ids already logged as updated, including ones that failed later", () => {
    const { updated } = parseApplyLog(APPLY_LOG);
    expect(classifyApplyRow("file-done", { resumeUpdated: updated })).toEqual({ action: "skip", reason: "already updated" });
    expect(classifyApplyRow("file-again", { resumeUpdated: updated })).toEqual({ action: "skip", reason: "already updated" });
    expect(classifyApplyRow("file-timeout", { resumeUpdated: updated })).toEqual({ action: "run" });
    expect(classifyApplyRow("file-new", { resumeUpdated: updated })).toEqual({ action: "run" });
  });

  it("retry-failed keeps only ids whose latest result is failed", () => {
    const { failed } = parseApplyLog(APPLY_LOG);
    expect(classifyApplyRow("file-timeout", { retryFailed: failed })).toEqual({ action: "run" });
    expect(classifyApplyRow("file-again", { retryFailed: failed })).toEqual({ action: "run" });
    expect(classifyApplyRow("file-done", { retryFailed: failed })).toEqual({ action: "skip", reason: "not listed as failed" });
    expect(classifyApplyRow("file-then-ok", { retryFailed: failed })).toEqual({ action: "skip", reason: "not listed as failed" });
  });
});

describe("apply request limits", () => {
  it("caps one attempt so client retries cannot wait for hours", () => {
    expect(applyAttemptBudgetMs(30_000, 2)).toBe(120_000);
  });

  it("rejects a hung request when the deadline passes and still returns a fast success", async () => {
    await expect(withDeadline(() => new Promise(() => undefined), 20)).rejects.toThrow(/timed out/i);
    await expect(withDeadline(async () => "ok", 1000)).resolves.toBe("ok");
  });

  it("retries a timeout with backoff and stops after 3 attempts", async () => {
    const delays: number[] = [];
    let calls = 0;
    await expect(retryOperation(
      async () => {
        calls += 1;
        throw new Error("Request timed out.");
      },
      {
        attempts: 3,
        delayMs: (failedAttempt) => 1000 * 2 ** (failedAttempt - 1),
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
      },
    )).rejects.toThrow(/timed out/i);
    expect(calls).toBe(3);
    expect(delays).toEqual([1000, 2000]);
  });

  it("does not keep retrying after a later attempt succeeds", async () => {
    let calls = 0;
    const value = await retryOperation(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("Request timed out.");
        return "updated";
      },
      {
        attempts: 3,
        delayMs: () => 50,
        sleep: async () => undefined,
      },
    );
    expect(value).toBe("updated");
    expect(calls).toBe(2);
  });
});
