import { afterEach, describe, expect, it, vi } from "vitest";

import { FILE_SEARCH_MAX_RESULTS, FILE_SEARCH_RANKING_OPTIONS } from "@/lib/file-search";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  config: vi.fn(),
  usage: vi.fn(),
  log: vi.fn(),
  client: vi.fn(),
  search: vi.fn(),
}));
vi.mock("openai", () => ({
  default: class {
    constructor(options: unknown) {
      mocks.client(options);
    }
    responses = { create: mocks.create };
    vectorStores = { search: mocks.search };
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
    expect(mocks.create.mock.calls[0][0].max_output_tokens).toBe(4000);
    expect(mocks.create.mock.calls[0][0].include).toEqual(["file_search_call.results"]);
    expect(mocks.create.mock.calls[0][0].instructions).toContain("America/Chicago");
    expect(mocks.create.mock.calls[0][0].instructions).toContain("in the past");
    expect(mocks.create.mock.calls[0][0].instructions).toContain("Language for this turn: English.");
    expect(mocks.create.mock.calls[0][0].instructions).toContain("You do not have a weather tool");
    expect(mocks.create.mock.calls[0][0].input.at(-2)).toEqual({
      role: "developer",
      content: expect.stringContaining("Language for this turn: English."),
    });
    expect(mocks.create.mock.calls[0][0].instructions).toContain("https://www.oak-park.us/Government/Information-and-Resources/Freedom-of-Information-Act-FOIA");
    expect(mocks.client).toHaveBeenCalledWith(expect.objectContaining({ timeout: 150_000, maxRetries: 0 }));
    expect(mocks.create.mock.calls[0][0].reasoning).toEqual({ effort: "medium" });
    expect(mocks.create.mock.calls[0][0].tools[0]).toEqual({
      type: "file_search",
      vector_store_ids: ["vs-oak"],
      max_num_results: FILE_SEARCH_MAX_RESULTS,
      ranking_options: FILE_SEARCH_RANKING_OPTIONS,
    });
    expect(body.citations[0].url).toBe("https://www.oakpark.com/story");
    expect(mocks.create.mock.calls[0][0].tools).toContainEqual(expect.objectContaining({ type: "web_search", external_web_access: true, filters: { allowed_domains: ["oakpark.com", "chicagotribune.com"] } }));
    expect(mocks.log.mock.calls[0][0].citations).toEqual(body.citations);
  });
  it("tells the model the latest question is Spanish", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue({ id: "oak", slug: "oak-park-il", name: "Oak Park", vectorStoreIds: ["vs-oak"] });
    mocks.create.mockResolvedValue({ output: [{ type: "message", content: [{ type: "output_text", text: "Pague en línea.", annotations: [] }] }] });
    await POST(new Request("https://app.test/api/chat", { method: "POST", body: JSON.stringify({ message: "[TEST] ¿Cómo pago una multa de estacionamiento?", municipalitySlug: "oak-park-il" }) }));
    expect(mocks.create.mock.calls[0][0].instructions).toContain("Language for this turn: Spanish.");
    expect(mocks.create.mock.calls[0][0].input.at(-2).content).toContain("Write every sentence of the answer in Spanish.");
    expect(mocks.create.mock.calls[0][0].input.at(-1)).toEqual({ role: "user", content: "[TEST] ¿Cómo pago una multa de estacionamiento?" });
  });
  it("keeps Strawberry Point restricted to its own document search", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue({ id: "sp", slug: "strawberry-point-ia", name: "Strawberry Point", vectorStoreIds: ["vs-sp"] });
    mocks.create.mockResolvedValue({ output: [{ type: "message", content: [{ type: "output_text", text: "A documented answer", annotations: [{ type: "file_citation", file_id: "file-sp", filename: "minutes.pdf" }] }] }] });
    const response = await POST(new Request("https://app.test/api/chat", { method: "POST", body: JSON.stringify({ message: "Council minutes", municipalitySlug: "strawberry-point-ia" }) }));
    const body = await response.json();
    expect(body.newsSearched).toBe(false);
    expect(body.citations).toEqual([{ fileId: "file-sp", filename: "minutes.pdf" }]);
    expect(mocks.create.mock.calls[0][0].model).toBe("gpt-5.4-mini");
    expect(mocks.create.mock.calls[0][0].reasoning).toEqual({ effort: "medium" });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.create.mock.calls[0][0].tools).toEqual([{
      type: "file_search",
      vector_store_ids: ["vs-sp"],
      max_num_results: FILE_SEARCH_MAX_RESULTS,
      ranking_options: FILE_SEARCH_RANKING_OPTIONS,
    }]);
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

  it("uses the configured model and reasoning effort", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    vi.stubEnv("MUNIGPT_CHAT_MODEL", "gpt-5.4-mini");
    vi.stubEnv("MUNIGPT_REASONING_EFFORT", "low");
    mocks.config.mockResolvedValue({ id: "oak", slug: "oak-park-il", name: "Oak Park", vectorStoreIds: ["vs-oak"] });
    mocks.create.mockResolvedValue({ output: [{ type: "message", content: [{ type: "output_text", text: "A short answer.", annotations: [] }] }] });
    await POST(new Request("https://app.test/api/chat", { method: "POST", body: JSON.stringify({ message: "Who is the village president?", municipalitySlug: "oak-park-il" }) }));
    expect(mocks.create.mock.calls[0][0].model).toBe("gpt-5.4-mini");
    expect(mocks.create.mock.calls[0][0].reasoning).toEqual({ effort: "low" });
    expect(mocks.create.mock.calls[0][0].max_output_tokens).toBe(1600);
  });

  it("keeps a pinned model that cannot reason", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    vi.stubEnv("OPENAI_MODEL", "gpt-4.1-mini");
    mocks.config.mockResolvedValue({ id: "sp", slug: "strawberry-point-ia", name: "Strawberry Point", vectorStoreIds: ["vs-sp"] });
    mocks.create.mockResolvedValue({ output: [{ type: "message", content: [{ type: "output_text", text: "A documented answer.", annotations: [] }] }] });
    await POST(new Request("https://app.test/api/chat", { method: "POST", body: JSON.stringify({ message: "Council minutes", municipalitySlug: "strawberry-point-ia" }) }));
    expect(mocks.create.mock.calls[0][0].model).toBe("gpt-4.1-mini");
    expect(mocks.create.mock.calls[0][0].reasoning).toBeUndefined();
    expect(mocks.create.mock.calls[0][0].max_output_tokens).toBe(800);
    expect(mocks.create.mock.calls[0][0].tools[0].filters).toBeUndefined();
  });

  it("filters a typed Oak Park question and shows title and record_date to the model", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue({ id: "oak", slug: "oak-park-il", name: "Oak Park", vectorStoreIds: ["vs-oak"] });
    mocks.search.mockResolvedValue({
      data: [
        { file_id: "file-old", filename: "2017-minutes.pdf", attributes: { title: "Old minutes", record_date: 20170918, document_type: "minutes" } },
        { file_id: "file-new", filename: "2026-10-13-minutes.pdf", attributes: { title: "October 13 minutes", record_date: 20261013, document_type: "minutes", status: "current" } },
        { file_id: "file-undated", filename: "packet.pdf", attributes: { title: "Packet", document_type: "minutes" } },
      ],
    });
    mocks.create.mockResolvedValue({ output: [{ type: "message", content: [{ type: "output_text", text: "The board met.", annotations: [] }] }] });
    const response = await POST(new Request("https://app.test/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "What did the minutes say about the budget?", municipalitySlug: "oak-park-il" }),
    }));
    expect(response.status).toBe(200);
    const filters = { type: "in", key: "document_type", value: ["minutes", "budget"] };
    expect(mocks.create.mock.calls[0][0].tools[0].filters).toEqual(filters);
    expect(mocks.search).toHaveBeenCalledWith(
      "vs-oak",
      expect.objectContaining({ query: "What did the minutes say about the budget?", filters, rewrite_query: true }),
      expect.objectContaining({ timeout: 8_000 }),
    );
    const index = mocks.create.mock.calls[0][0].input.at(-2).content as string;
    expect(index).toContain("title: October 13 minutes");
    expect(index).toContain("record_date: 20261013");
    expect(index).toContain("record_date: none");
    expect(index.indexOf("2026-10-13-minutes.pdf")).toBeLessThan(index.indexOf("2017-minutes.pdf"));
    expect(index.indexOf("2017-minutes.pdf")).toBeLessThan(index.indexOf("record_date: none"));
  });

  it("does not filter history questions or a lone ordinance question", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue({ id: "oak", slug: "oak-park-il", name: "Oak Park", vectorStoreIds: ["vs-oak"] });
    mocks.create.mockResolvedValue({ output: [{ type: "message", content: [{ type: "output_text", text: "The rule is in the guidelines.", annotations: [] }] }] });
    await POST(new Request("https://app.test/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "What does the fence ordinance allow?", municipalitySlug: "oak-park-il" }),
    }));
    expect(mocks.create.mock.calls[0][0].tools[0].filters).toBeUndefined();
    expect(mocks.search.mock.calls[0][1].filters).toBeUndefined();
  });

  it("still answers when the attribute index search fails", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue({ id: "oak", slug: "oak-park-il", name: "Oak Park", vectorStoreIds: ["vs-oak"] });
    mocks.search.mockRejectedValue(Object.assign(new Error("slow index"), { name: "APIConnectionTimeoutError" }));
    mocks.create.mockResolvedValue({ output: [{ type: "message", content: [{ type: "output_text", text: "An answer.", annotations: [] }] }] });
    const response = await POST(new Request("https://app.test/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Latest Oak Park news", municipalitySlug: "oak-park-il" }),
    }));
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalled();
  });

  it("stops the turn when the caller aborts the attribute search", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue({ id: "oak", slug: "oak-park-il", name: "Oak Park", vectorStoreIds: ["vs-oak"] });
    mocks.search.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const response = await POST(new Request("https://app.test/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "Next board meeting", municipalitySlug: "oak-park-il" }),
    }));
    const body = await response.json();
    expect(response.status).toBe(504);
    expect(body.error).toBe("That search took too long. Please try again.");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
