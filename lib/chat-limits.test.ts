import { afterEach, describe, expect, it, vi } from "vitest";

import { hashRequestIdentity } from "./chat-limits";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("public-client hashing", () => {
  it("is stable for the same forwarded address without storing the address", () => {
    vi.stubEnv("RATE_LIMIT_SALT", "test-only-secret");
    const request = new Request("https://example.gov/api/chat", {
      headers: { "x-forwarded-for": "203.0.113.8, 10.0.0.1" },
    });

    const first = hashRequestIdentity(request);
    const second = hashRequestIdentity(request);

    expect(first).toBe(second);
    expect(first).toHaveLength(64);
    expect(first).not.toContain("203.0.113.8");
  });

  it("changes when the secret salt changes", () => {
    const request = new Request("https://example.gov/api/chat", {
      headers: { "x-real-ip": "203.0.113.8" },
    });
    vi.stubEnv("RATE_LIMIT_SALT", "first-secret");
    const first = hashRequestIdentity(request);
    vi.stubEnv("RATE_LIMIT_SALT", "second-secret");

    expect(hashRequestIdentity(request)).not.toBe(first);
  });
});
