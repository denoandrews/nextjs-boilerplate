/** How long the server waits on one OpenAI call before failing the turn. */
export const OPENAI_REQUEST_TIMEOUT_MS = 50_000;

/** Slightly longer than the server timeout so the UI can show the server's error first. */
export const CHAT_CLIENT_TIMEOUT_MS = 60_000;

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
