import { afterEach, describe, expect, it, vi } from "vitest";

import { modelSupportsReasoning, resolveChatModel } from "./chat-model";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chat model and reasoning effort", () => {
  it("keeps gpt-5.4-mini for newspaper search and defaults reasoning to medium", () => {
    expect(modelSupportsReasoning("gpt-5.4-mini")).toBe(true);
    expect(modelSupportsReasoning("gpt-4.1-mini")).toBe(false);
    expect(resolveChatModel({ newsEnabled: true })).toEqual({
      model: "gpt-5.4-mini",
      reasoning: { effort: "medium" },
    });
  });

  it("replaces the non-reasoning fallback so medium reasoning can be sent", () => {
    expect(resolveChatModel({ newsEnabled: false })).toEqual({
      model: "gpt-5.4-mini",
      reasoning: { effort: "medium" },
    });
  });

  it("honors an explicit model and effort", () => {
    vi.stubEnv("MUNIGPT_CHAT_MODEL", " gpt-5.4-mini ");
    vi.stubEnv("MUNIGPT_REASONING_EFFORT", "HIGH");
    expect(resolveChatModel({ newsEnabled: false })).toEqual({
      model: "gpt-5.4-mini",
      reasoning: { effort: "high" },
    });
  });

  it("keeps a pinned model that cannot reason and does not send an effort", () => {
    vi.stubEnv("OPENAI_MODEL", "gpt-4.1-mini");
    vi.stubEnv("MUNIGPT_REASONING_EFFORT", "medium");
    expect(resolveChatModel({ newsEnabled: false })).toEqual({ model: "gpt-4.1-mini" });

    vi.stubEnv("MUNIGPT_CHAT_MODEL", "gpt-4.1-mini");
    expect(resolveChatModel({ newsEnabled: true })).toEqual({ model: "gpt-4.1-mini" });
  });

  it("falls back to medium when the effort is missing or unsupported", () => {
    vi.stubEnv("MUNIGPT_REASONING_EFFORT", "minimal");
    expect(resolveChatModel({ newsEnabled: true }).reasoning).toEqual({ effort: "medium" });
    vi.stubEnv("MUNIGPT_REASONING_EFFORT", "");
    expect(resolveChatModel({ newsEnabled: true }).reasoning).toEqual({ effort: "medium" });
  });

  it("sends none when that effort is requested", () => {
    vi.stubEnv("MUNIGPT_REASONING_EFFORT", "none");
    expect(resolveChatModel({ newsEnabled: true })).toEqual({
      model: "gpt-5.4-mini",
      reasoning: { effort: "none" },
    });
  });
});
