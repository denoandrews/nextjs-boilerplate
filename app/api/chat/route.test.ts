import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

function chatRequest(body: unknown) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/chat", () => {
  it("rejects an empty question", async () => {
    const response = await POST(chatRequest({ message: "   " }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Request-ID")).toBeTruthy();
    expect(body.error).toBe("Type a question and press Send.");
  });

  it("rejects an oversized question", async () => {
    const response = await POST(chatRequest({ message: "x".repeat(2_001) }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("2,000 characters or fewer");
  });

  it("does not expose missing server configuration details", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("VECTOR_STORE_ID", "");
    vi.stubEnv("VECTOR_STORE_IDS", "");

    const response = await POST(chatRequest({ message: "What did the council approve?" }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe("MuniGPT is not configured.");
    expect(JSON.stringify(body)).not.toContain("OPENAI_API_KEY");
  });
});
