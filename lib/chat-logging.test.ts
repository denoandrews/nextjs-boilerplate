import { afterEach, describe, expect, it, vi } from "vitest";

import { chatLogDisabled, logChatExchange } from "./chat-logging";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chat log switch", () => {
  it("skips persistence when MUNIGPT_DISABLE_CHAT_LOG is set", async () => {
    vi.stubEnv("MUNIGPT_DISABLE_CHAT_LOG", "1");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "pk");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
    expect(chatLogDisabled()).toBe(true);
    await expect(logChatExchange({
      municipalityId: "oak",
      question: "Hi",
      answer: "Hello",
      citations: [],
      requestId: "r",
      model: "gpt-5.4-mini",
    })).resolves.toEqual({});
  });
});
