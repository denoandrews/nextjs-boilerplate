import { describe, expect, it } from "vitest";
import { CHAT_CLIENT_TIMEOUT_MS, CHAT_MAX_DURATION_SECONDS, OPENAI_REQUEST_TIMEOUT_MS, requestTimedOut } from "./chat-request";

describe("chat request timeout", () => {
  it("keeps the browser timeout between the OpenAI timeout and the platform limit", () => {
    expect(CHAT_MAX_DURATION_SECONDS).toBeLessThanOrEqual(300);
    expect(OPENAI_REQUEST_TIMEOUT_MS).toBeLessThan(CHAT_MAX_DURATION_SECONDS * 1000);
    expect(CHAT_CLIENT_TIMEOUT_MS).toBeGreaterThan(OPENAI_REQUEST_TIMEOUT_MS);
    expect(CHAT_CLIENT_TIMEOUT_MS).toBeLessThan(CHAT_MAX_DURATION_SECONDS * 1000);
  });

  it("recognizes provider and abort timeouts", () => {
    expect(requestTimedOut(Object.assign(new Error("slow"), { name: "APIConnectionTimeoutError" }))).toBe(true);
    expect(requestTimedOut(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);
    expect(requestTimedOut(new Error("nope"))).toBe(false);
    expect(requestTimedOut(null)).toBe(false);
  });
});
