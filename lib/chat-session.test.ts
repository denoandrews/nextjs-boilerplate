import { describe, expect, it } from "vitest";
import { chatStorageKey, parseChatSnapshot, serializeChatSnapshot } from "./chat-session";

describe("chat session snapshot", () => {
  it("round-trips a conversation for one municipality", () => {
    const raw = serializeChatSnapshot({
      messages: [
        { role: "assistant", text: "Ask a question about the municipality's public records." },
        { role: "user", text: "When is the next meeting?" },
        {
          role: "assistant",
          text: "That search took too long. Please try again.",
          retryQuestion: "When is the next meeting?",
          citations: [{ fileId: "file-1", filename: "agenda.pdf", url: "https://www.oak-park.us/agenda" }],
        },
      ],
      conversationId: "conv-1",
      municipality: "Oak Park",
    });
    expect(chatStorageKey("oak-park-il")).toBe("munigpt-chat:oak-park-il");
    expect(parseChatSnapshot(raw)).toMatchObject({
      conversationId: "conv-1",
      municipality: "Oak Park",
      messages: [
        { role: "assistant", text: "Ask a question about the municipality's public records." },
        { role: "user", text: "When is the next meeting?" },
        { retryQuestion: "When is the next meeting?", citations: [{ fileId: "file-1" }] },
      ],
    });
  });

  it("drops malformed snapshots instead of crashing the chat", () => {
    expect(parseChatSnapshot(null)).toBeNull();
    expect(parseChatSnapshot("{")).toBeNull();
    expect(parseChatSnapshot(JSON.stringify({ messages: [{ role: "system", text: "nope" }] }))).toBeNull();
  });
});
