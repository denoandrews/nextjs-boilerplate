import { describe, expect, it } from "vitest";

import { readChatEvents } from "./chat-stream";

describe("chat progress stream", () => {
  it("reports progress and returns the final result", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"type":"progress","message":"Searching the village website and newspapers…"}\n\n',
      'data: {"type":"progress","message":"Searching municipal records…"}\n\n',
      'data: {"type":"result","answer":"The budget increased.","officialSearched":true,"newsSearched":true}\n\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const progress: string[] = [];
    const result = await readChatEvents(stream, (message) => progress.push(message));
    expect(progress).toEqual([
      "Searching the village website and newspapers…",
      "Searching municipal records…",
    ]);
    expect(result.answer).toBe("The budget increased.");
    expect(result.officialSearched).toBe(true);
  });
});
