import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), config: vi.fn(), usage: vi.fn(), log: vi.fn(), client: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    constructor(options: unknown) {
      mocks.client(options);
    }
    responses = { create: mocks.create };
  },
}));
vi.mock("@/lib/municipalities", () => ({ getMunicipalityConfig: mocks.config }));
vi.mock("@/lib/chat-limits", () => ({ reserveChatQuery: async () => ({ allowed: true }) }));
vi.mock("@/lib/chat-logging", () => ({ logChatExchange: async (input: unknown) => { mocks.log(input); return {}; } }));
vi.mock("@/lib/chat-usage", () => ({ extractChatUsage: () => ({}), logUsageEvent: mocks.usage }));
import { POST } from "./route";

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe("newspaper search request flow", () => {
  it("adds filtered live search and returns an inline linked source for Oak Park", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue({ id: "oak", slug: "oak-park-il", name: "Oak Park", vectorStoreIds: ["vs-oak"] });
    mocks.create.mockResolvedValue({ output: [{ type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: "News CITE", annotations: [{ type: "url_citation", url: "https://www.oakpark.com/story", title: "Article", start_index: 5, end_index: 9 }] }] }] });
    const response = await POST(new Request("https://app.test/api/chat", { method: "POST", body: JSON.stringify({ message: "Latest Oak Park news", municipalitySlug: "oak-park-il" }) }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.answer).toBe("News [News 1]");
    expect(body.newsSearched).toBe(true);
    expect(mocks.create.mock.calls[0][0].model).toBe("gpt-5.4-mini");
    expect(mocks.create.mock.calls[0][0].max_output_tokens).toBe(1600);
    expect(mocks.create.mock.calls[0][0].include).toEqual(["file_search_call.results"]);
    expect(mocks.create.mock.calls[0][0].instructions).toContain("America/Chicago");
    expect(mocks.create.mock.calls[0][0].instructions).toContain("in the past");
    expect(mocks.create.mock.calls[0][0].instructions).toContain("You do not have a weather tool");
    expect(mocks.create.mock.calls[0][0].instructions).toContain("https://www.oak-park.us/Government/Information-and-Resources/Freedom-of-Information-Act-FOIA");
    expect(mocks.client).toHaveBeenCalledWith(expect.objectContaining({ timeout: 50_000, maxRetries: 0 }));
    expect(mocks.create.mock.calls[0][0].reasoning).toEqual({ effort: "none" });
    expect(body.citations[0].url).toBe("https://www.oakpark.com/story");
    expect(mocks.create.mock.calls[0][0].tools).toContainEqual(expect.objectContaining({ type: "web_search", external_web_access: true, filters: { allowed_domains: ["oakpark.com", "chicagotribune.com"] } }));
    expect(mocks.log.mock.calls[0][0].citations).toEqual(body.citations);
  });
  it("keeps Strawberry Point restricted to its own document search", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue({ id: "sp", slug: "strawberry-point-ia", name: "Strawberry Point", vectorStoreIds: ["vs-sp"] });
    mocks.create.mockResolvedValue({ output: [{ type: "message", content: [{ type: "output_text", text: "A documented answer", annotations: [{ type: "file_citation", file_id: "file-sp", filename: "minutes.pdf" }] }] }] });
    const response = await POST(new Request("https://app.test/api/chat", { method: "POST", body: JSON.stringify({ message: "Council minutes", municipalitySlug: "strawberry-point-ia" }) }));
    const body = await response.json();
    expect(body.newsSearched).toBe(false);
    expect(body.citations).toEqual([{ fileId: "file-sp", filename: "minutes.pdf" }]);
    expect(mocks.create.mock.calls[0][0].tools).toEqual([{ type: "file_search", vector_store_ids: ["vs-sp"], max_num_results: 8 }]);
    expect(mocks.create.mock.calls[0][0].instructions).not.toContain("oak-park.us");
  });
  it("returns a retryable error when the model call times out", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue({ id: "oak", slug: "oak-park-il", name: "Oak Park", vectorStoreIds: ["vs-oak"] });
    mocks.create.mockRejectedValue(Object.assign(new Error("timed out"), { name: "APIConnectionTimeoutError" }));
    const response = await POST(new Request("https://app.test/api/chat", { method: "POST", body: JSON.stringify({ message: "Next board meeting", municipalitySlug: "oak-park-il" }) }));
    const body = await response.json();
    expect(response.status).toBe(504);
    expect(body.error).toBe("That search took too long. Please try again.");
  });
});
