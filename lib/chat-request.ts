/**
 * Platform budget for /api/chat, in seconds. Must match the numeric
 * `maxDuration` export in app/api/chat/route.ts. Next.js only reads that
 * literal. 180 stays under the 300s hobby limit and leaves room for medium
 * reasoning on gpt-5.4-mini.
 */
export const CHAT_MAX_DURATION_SECONDS = 180;

/**
 * How long the server waits on one OpenAI call before failing the turn.
 * Stays under maxDuration so the timeout response can still be sent.
 */
export const OPENAI_REQUEST_TIMEOUT_MS = 150_000;

/** Slightly longer than the server timeout so the UI can show the server's error first. */
export const CHAT_CLIENT_TIMEOUT_MS = 165_000;

export const OPENAI_MAX_RETRIES = 0;

export function requestTimedOut(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("name" in error)) return false;
  const name = error.name;
  return (
    name === "APIConnectionTimeoutError" ||
    name === "APIUserAbortError" ||
    name === "TimeoutError" ||
    name === "AbortError"
  );
}
