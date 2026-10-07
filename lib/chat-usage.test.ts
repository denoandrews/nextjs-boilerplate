import { afterEach, describe, expect, it, vi } from "vitest";

import { estimateCostMicrousd, extractChatUsage } from "./chat-usage";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("chat usage accounting", () => {
  it("estimates the default gpt-4.1-mini and file-search cost", () => {
    expect(
      estimateCostMicrousd({
        inputTokens: 6_000,
        cachedInputTokens: 0,
        outputTokens: 500,
        totalTokens: 6_500,
        fileSearchCalls: 1,
      })
    ).toBe(5_700);
  });

  it("uses the lower cached-input rate and configurable prices", () => {
    vi.stubEnv("OPENAI_INPUT_COST_PER_MILLION", "1");
    vi.stubEnv("OPENAI_CACHED_INPUT_COST_PER_MILLION", "0.25");
    vi.stubEnv("OPENAI_OUTPUT_COST_PER_MILLION", "2");
    vi.stubEnv("OPENAI_FILE_SEARCH_COST_PER_THOUSAND", "3");

    expect(
      estimateCostMicrousd({
        inputTokens: 1_000,
        cachedInputTokens: 400,
        outputTokens: 100,
        totalTokens: 1_100,
        fileSearchCalls: 2,
      })
    ).toBe(6_900);
  });

  it("extracts exact token counts and file-search calls from a response", () => {
    const usage = extractChatUsage({
      usage: {
        input_tokens: 123,
        input_tokens_details: { cached_tokens: 23, cache_write_tokens: 0 },
        output_tokens: 45,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 168,
      },
      output: [{ type: "file_search_call" }, { type: "message" }],
    } as never);

    expect(usage).toMatchObject({
      inputTokens: 123,
      cachedInputTokens: 23,
      outputTokens: 45,
      totalTokens: 168,
      fileSearchCalls: 1,
    });
  });
});
