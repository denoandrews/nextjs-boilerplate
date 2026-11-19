import { describe, expect, it } from "vitest";

import { describeChatResponse } from "./chat-diagnostics";

describe("chat response diagnostics", () => {
  it("reports reasoning tokens, file searches, and an incomplete reason when there is no text", () => {
    const diagnostics = describeChatResponse({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 16_000,
        output_tokens_details: { reasoning_tokens: 16_000 },
        total_tokens: 16_010,
      },
      output: [{ type: "file_search_call" }, { type: "file_search_call" }],
    } as never);

    expect(diagnostics).toEqual({
      status: "incomplete",
      reasoningTokens: 16_000,
      searchCount: 2,
      incompleteReason: "max_output_tokens",
      hasOutputText: false,
    });
  });

  it("sees output text on a completed answer", () => {
    const diagnostics = describeChatResponse({
      status: "completed",
      incomplete_details: null,
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 4 },
        total_tokens: 30,
      },
      output: [{ type: "message", content: [{ type: "output_text", text: "The board adopted the ordinance." }] }],
    } as never);

    expect(diagnostics.hasOutputText).toBe(true);
    expect(diagnostics.incompleteReason).toBeNull();
    expect(diagnostics.reasoningTokens).toBe(4);
  });
});
