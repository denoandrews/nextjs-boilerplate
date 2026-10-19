import { describe, expect, it } from "vitest";
import { CHAT_CLIENT_TIMEOUT_MS, OPENAI_REQUEST_TIMEOUT_MS, requestTimedOut } from "./chat-request";

describe("chat request timeout", () => {
  it("keeps the browser timeout just behind the server timeout", () => {
    expect(CHAT_CLIENT_TIMEOUT_MS).toBeGreaterThan(OPENAI_REQUEST_TIMEOUT_MS);
    expect(OPENAI_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(55_000);
  });

  it("recognizes provider and abort timeouts", () => {
    expect(requestTimedOut(Object.assign(new Error("slow"), { name: "APIConnectionTimeoutError" }))).toBe(true);
    expect(requestTimedOut(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(requestTimedOut(new Error("nope"))).toBe(false);
    expect(requestTimedOut(null)).toBe(false);
  });
});
