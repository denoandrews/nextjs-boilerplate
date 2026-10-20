/**
 * Parse an apply log and decide which rows a later run should touch.
 * Chat search does not import this module.
 */

const APPLY_LOG_LINE = /^(?:\S+\s+)?(updated|failed|skipped)\s+(file-\S+)/;

export type ApplyLogSets = {
  /** File ids with at least one `updated` line. */
  updated: Set<string>;
  /** File ids whose latest update-or-fail line is `failed`. */
  failed: Set<string>;
};

export function parseApplyLog(text: string): ApplyLogSets {
  const updated = new Set<string>();
  const latest = new Map<string, "updated" | "failed">();
  for (const line of text.split(/\n/)) {
    const match = APPLY_LOG_LINE.exec(line.trim());
    if (!match) continue;
    const action = match[1] as "updated" | "failed" | "skipped";
    const fileId = match[2];
    if (action === "skipped") continue;
    if (action === "updated") updated.add(fileId);
    latest.set(fileId, action);
  }
  const failed = new Set<string>();
  for (const [fileId, action] of latest) {
    if (action === "failed") failed.add(fileId);
  }
  return { updated, failed };
}

export function classifyApplyRow(
  fileId: string,
  options: { resumeUpdated?: ReadonlySet<string>; retryFailed?: ReadonlySet<string> },
): { action: "run" } | { action: "skip"; reason: string } {
  if (options.resumeUpdated?.has(fileId)) return { action: "skip", reason: "already updated" };
  if (options.retryFailed && !options.retryFailed.has(fileId)) return { action: "skip", reason: "not listed as failed" };
  return { action: "run" };
}

/** One apply attempt may include the client's own retries. Keep a hard cap so a hung request cannot stall the loop. */
export function applyAttemptBudgetMs(timeoutMs: number, maxRetries = 2): number {
  return timeoutMs * (maxRetries + 1) + 30_000;
}

export function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let settled = false;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort();
      reject(new Error("Request timed out."));
    }, timeoutMs);
    const pending = operation(controller.signal);
    pending.catch(() => undefined);
    pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function retryOperation<T>(
  operation: () => Promise<T>,
  options: {
    attempts: number;
    delayMs: (failedAttempt: number) => number;
    sleep: (milliseconds: number) => Promise<void>;
    onError?: (error: unknown, failedAttempt: number) => void;
  },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      options.onError?.(error, attempt);
      if (attempt === options.attempts) break;
      await options.sleep(options.delayMs(attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
