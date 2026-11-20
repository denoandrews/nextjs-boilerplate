import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  config: vi.fn(),
  search: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    responses = { create: mocks.create };
    vectorStores = { search: mocks.search };
  },
}));
vi.mock("@/lib/municipalities", () => ({ getMunicipalityConfig: mocks.config }));
vi.mock("@/lib/chat-limits", () => ({ reserveChatQuery: async () => ({ allowed: true }) }));
vi.mock("@/lib/chat-logging", () => ({ logChatExchange: async () => ({ conversationId: "conv-test" }) }));

import { POST } from "./route";

const OAK = { id: "oak", slug: "oak-park-il", name: "Oak Park", vectorStoreIds: ["vs-oak"] };

function request(message: string, extra: Record<string, unknown> = {}) {
  return new Request("https://app.test/api/chat", {
    method: "POST",
    body: JSON.stringify({ message, municipalitySlug: "oak-park-il", ...extra }),
  });
}

function textResponse(text: string, annotations: unknown[] = []) {
  return {
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text, annotations }] }],
    usage: {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 30,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 50,
    },
  };
}

function callKind(body: { tools?: { type?: string }[]; instructions?: string }) {
  const tools = body.tools ?? [];
  if (tools.some((tool) => tool.type === "web_search")) return "web";
  if (String(body.instructions).includes("Return JSON")) return "plan";
  return "answer";
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([])));
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("research mode", () => {
  it("searches records, the village website, and newspapers in parallel for every Oak Park question", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{
      MatterId: 8520,
      MatterGuid: "D6F507E1-FCC1-476B-9F65-CC50D7408515",
      MatterFile: "MOT 24-142",
      MatterTitle: "A Motion to Expand Overnight On-Street Permit Parking in Zones Y1 and Y2",
      MatterTypeName: "Motion",
      MatterStatusName: "Passed",
      MatterIntroDate: "2024-03-18T00:00:00",
      MatterPassedDate: "2024-04-11T00:00:00",
    }])));
    mocks.config.mockResolvedValue(OAK);
    mocks.search.mockImplementation(async (_id: string, params: { query?: string }) => {
      const query = String(params.query);
      if (/2024/.test(query)) {
        return { data: [{ file_id: "file-2024", filename: "2024-06-18-overnight-ordinance.pdf", score: 0.78, attributes: { record_date: 20240618, document_type: "ordinance", title: "ORD 24-124" }, content: [{ text: "ORD 24-124 expanded overnight parking in June 2024." }] }] };
      }
      if (/2023/.test(query)) {
        return { data: [{ file_id: "file-2023", filename: "ORD-23-118.pdf", score: 0.74, attributes: { record_date: 20231218, document_type: "ordinance", title: "ORD 23-118" }, content: [{ text: "ORD 23-118 reduced the overnight parking permit fee in December 2023." }] }] };
      }
      return { data: [{ file_id: "file-2021", filename: "2021-overnight-ordinance.pdf", score: 0.86, attributes: { record_date: 20210222, document_type: "ordinance", title: "2021 ordinance" }, content: [{ text: "The February 2021 ordinance set the overnight pass count." }] }] };
    });
    mocks.create.mockImplementation(async (body: { tools?: { type?: string; filters?: { allowed_domains?: string[] } }[]; instructions?: string; input?: unknown }) => {
      const kind = callKind(body);
      if (kind === "plan") return textResponse('{"queries":["overnight parking 2024 minutes"]}');
      if (kind === "web") {
        const domains = body.tools?.[0]?.filters?.allowed_domains ?? [];
        if (domains.includes("oak-park.us")) {
          return textResponse("Overnight parking permit rules changed for 2024.", [
            { type: "url_citation", url: "https://www.oak-park.us/parking", title: "Parking", start_index: 0, end_index: 46 },
          ]);
        }
        return textResponse("Wednesday Journal reported the overnight parking fee.", [
          { type: "url_citation", url: "https://www.oakpark.com/parking-fee", title: "Parking fee", start_index: 0, end_index: 52 },
        ]);
      }
      const evidence = JSON.stringify(body.input);
      expect(evidence.indexOf("ORD 24-124")).toBeGreaterThan(-1);
      expect(evidence.indexOf("ORD 24-124")).toBeLessThan(evidence.indexOf("February 2021 ordinance"));
      expect(evidence.indexOf("December 2023")).toBeGreaterThan(-1);
      expect(evidence.indexOf("source: official website")).toBeLessThan(evidence.indexOf("source: newspaper reporting"));
      expect(evidence).toContain("MOT 24-142");
      expect(evidence).toContain("adopted this motion on 2024-04-11");
      expect(evidence).toContain("https://oak-park.legistar.com/LegislationDetail.aspx?ID=8520");
      expect(evidence).toContain("First Reading is a proposal, not an adoption");
      return textResponse("The 2024 ordinance changed overnight parking. [1]");
    });

    const response = await POST(request("What is the current overnight parking policy?"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.answer).toContain("2024 ordinance");
    expect(body.answer).not.toContain("The Wednesday Journal reported:");
    expect(body.officialSearched).toBe(true);
    expect(body.newsSearched).toBe(true);
    const bodies = mocks.create.mock.calls.map((call) => call[0]);
    const webCalls = bodies.filter((call) => callKind(call) === "web");
    expect(webCalls.length).toBeGreaterThanOrEqual(2);
    const domainSets = webCalls.map((call) => (call.tools[0].filters.allowed_domains as string[]).slice().sort().join("|"));
    expect(domainSets).toContain(["chicagotribune.com", "oakpark.com", "www.chicagotribune.com", "www.oakpark.com"].sort().join("|"));
    expect(domainSets).toContain(["oak-park.legistar.com", "oak-park.us", "www.oak-park.us"].sort().join("|"));
    expect(domainSets).not.toContain("oak-park.legistar.com");
    const legistarUrls = vi.mocked(fetch).mock.calls.map((call) => String(call[0]));
    expect(legistarUrls.some((url) => url.includes("webapi.legistar.com/v1/oak-park/matters"))).toBe(true);
    expect(mocks.search.mock.calls.some((call) => {
      const filters = call[1]?.filters as { filters?: { key?: string }[] } | undefined;
      return filters?.filters?.some((filter) => filter.key === "record_date");
    })).toBe(true);
    expect(mocks.search.mock.calls.length).toBeGreaterThan(2);
  });

  it("does not return a blank answer for a three-year budget question", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue(OAK);
    mocks.search.mockResolvedValue({ data: [{ file_id: "file-budget", filename: "fy26-budget-book.pdf", score: 0.8, attributes: { document_type: "budget", record_date: 20260101 }, content: [{ text: "The FY2026 budget book compares FY2024 and FY2025 spending." }] }] });
    let answers = 0;
    mocks.create.mockImplementation(async (body: { tools?: { type?: string }[]; instructions?: string }) => {
      const kind = callKind(body);
      if (kind === "plan") return textResponse('{"queries":["FY2024 budget"]}');
      if (kind === "web") return textResponse("No matching page.", []);
      answers += 1;
      if (answers === 1) {
        return {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
          usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 16000, output_tokens_details: { reasoning_tokens: 16000 }, total_tokens: 16010 },
        };
      }
      return textResponse("Spending rose from FY2024 through FY2026 because pension costs increased. [1]");
    });
    const response = await POST(request("How has the village budget changed over the last three years?"));
    const body = await response.json();
    expect(body.answer).toContain("FY2024");
    expect(body.answer).not.toContain("could not establish");
    const queries = mocks.search.mock.calls.map((call) => String(call[1].query));
    expect(queries.some((query) => query.includes("FY2024"))).toBe(true);
    expect(queries.some((query) => query.includes("FY2025"))).toBe(true);
    expect(queries.some((query) => query.includes("FY2026"))).toBe(true);
  });

  it("sends a relevant budget story to synthesis without a stock newspaper line", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue(OAK);
    mocks.search.mockResolvedValue({ data: [{ file_id: "file-budget", filename: "fy26-budget-book.pdf", score: 0.8, attributes: { document_type: "budget", record_date: 20260101 }, content: [{ text: "The FY2026 budget book compares FY2024 and FY2025 spending." }] }] });
    mocks.create.mockImplementation(async (body: { tools?: { type?: string; filters?: { allowed_domains?: string[] } }[]; instructions?: string; input?: unknown }) => {
      const kind = callKind(body);
      if (kind === "plan") return textResponse('{"queries":["FY2024 budget"]}');
      if (kind === "web") {
        const domains = body.tools?.[0]?.filters?.allowed_domains ?? [];
        if (domains.includes("oakpark.com")) {
          return textResponse("The village drew on budget reserves to balance the budget.", [
            { type: "url_citation", url: "https://www.oakpark.com/reserves?utm_source=openai", title: "Budget reserves", start_index: 0, end_index: 24 },
          ]);
        }
        return textResponse("Percy Julian streetscape on Oak Park Avenue.");
      }
      const evidence = JSON.stringify(body.input);
      expect(evidence).toContain("budget reserves");
      expect(evidence).toContain("https://www.oakpark.com/reserves");
      expect(evidence).not.toContain("utm_source");
      expect(evidence).toContain("Integrate each relevant newspaper finding into the answer prose");
      expect(evidence).toContain("cite both");
      expect(evidence).not.toContain("Percy Julian");
      return textResponse("The budget grew and the village used reserves. [1]");
    });
    const response = await POST(request("How has the village budget changed over the last three years?"));
    const body = await response.json();
    expect(body.answer).toContain("reserves");
    expect(body.answer).not.toContain("The Wednesday Journal reported:");
    expect(body.newsSearched).toBe(true);
  });

  it("keeps the Lake Street construction contractor in the evidence for a multi-part question", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue(OAK);
    mocks.search.mockImplementation(async (_id: string, params: { query?: string }) => {
      if (/contractor/i.test(String(params.query))) {
        return { data: [{ file_id: "file-duntemann", filename: "2021-03-15-lake-street-contract.pdf", score: 0.8, attributes: { document_type: "ordinance", record_date: 20210315 }, content: [{ text: "The Lake Street streetscape construction contract was awarded to R.W. Duntemann Co. for $10,557,783." }] }] };
      }
      return { data: [{ file_id: "file-design", filename: "2019-design-amendment.pdf", score: 0.7, attributes: { record_date: 20190909, document_type: "resolution" }, content: [{ text: "Thomas Engineering Group amended the Lake Street design contract." }] }] };
    });
    mocks.create.mockImplementation(async (body: { tools?: { type?: string }[]; instructions?: string; input?: unknown }) => {
      const kind = callKind(body);
      if (kind === "plan") return textResponse('{"queries":["Lake Street design"]}');
      if (kind === "web") return textResponse("No matching page.");
      expect(JSON.stringify(body.input)).toContain("R.W. Duntemann Co.");
      return textResponse("The construction contractor was R.W. Duntemann Co. [1]");
    });
    const response = await POST(request("What did the board decide about the Lake Street streetscape, how much did it cost, who was the contractor, and were there any change orders?"));
    const body = await response.json();
    expect(body.answer).toContain("R.W. Duntemann Co.");
  });

  it("runs a website and newspaper pass for a person without hard-coding an office", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue(OAK);
    mocks.search.mockResolvedValue({ data: [] });
    mocks.create.mockImplementation(async (body: { tools?: { type?: string; filters?: { allowed_domains?: string[] } }[]; instructions?: string; input?: unknown }) => {
      const kind = callKind(body);
      if (kind === "plan") return textResponse('{"queries":["candidate only"]}');
      if (kind === "web") {
        expect(JSON.stringify(body.input)).toContain("Robert Milstein");
        return textResponse("Election filing for Robert Milstein as a candidate.");
      }
      const evidence = JSON.stringify(body.input);
      expect(evidence).not.toContain("former Village Trustee");
      expect(evidence).toContain("You must use every newspaper result whose article text names Robert Milstein");
      return textResponse("The retrieved records may be incomplete.");
    });
    const response = await POST(request("Who is Robert Milstein?"));
    const body = await response.json();
    const queries = mocks.search.mock.calls.map((call) => String(call[1].query));
    expect(queries).toEqual(expect.arrayContaining([
      "Robert Milstein trustee",
      "Robert Milstein village board",
      "Robert Milstein roll call",
      "Robert Milstein budget",
      "Robert Milstein president",
    ]));
    expect(body.answer).not.toContain("not a Village official");
    expect(body.answer).not.toContain("former Village Trustee");
    expect(body.officialSearched).toBe(true);
    expect(body.newsSearched).toBe(true);
  });

  it("skips research mode and the website pass when the env flags are off", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    vi.stubEnv("MUNIGPT_RESEARCH_MODE", "0");
    vi.stubEnv("MUNIGPT_WEB_SEARCH", "0");
    mocks.config.mockResolvedValue(OAK);
    mocks.create.mockResolvedValue(textResponse("A short answer."));
    const response = await POST(request("What is the current overnight parking policy?"));
    expect(response.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.search.mock.calls.some((call) => call[1]?.rewrite_query === false)).toBe(false);
    const domains = mocks.create.mock.calls[0][0].tools.find((tool: { type?: string }) => tool.type === "web_search").filters.allowed_domains;
    expect(domains).toEqual(["oakpark.com", "www.oakpark.com", "chicagotribune.com", "www.chicagotribune.com"]);
    expect(domains).not.toContain("oak-park.us");
  });

  it("retries a timed-out newspaper search once and does not mark that pass as searched", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only");
    mocks.config.mockResolvedValue(OAK);
    mocks.search.mockResolvedValue({ data: [] });
    let newsAttempts = 0;
    mocks.create.mockImplementation(async (body: { tools?: { type?: string; filters?: { allowed_domains?: string[] } }[]; instructions?: string }) => {
      const kind = callKind(body);
      if (kind === "plan") return textResponse('{"queries":["budget"]}');
      if (kind === "web") {
        const domains = body.tools?.[0]?.filters?.allowed_domains ?? [];
        if (domains.includes("oakpark.com")) {
          newsAttempts += 1;
          throw Object.assign(new Error("timed out"), { name: "APIConnectionTimeoutError" });
        }
        return textResponse("Village budget page.", [
          { type: "url_citation", url: "https://www.oak-park.us/budget", title: "Budget", start_index: 0, end_index: 18 },
        ]);
      }
      return textResponse("The budget grew. [1]");
    });
    const response = await POST(request("How has the village budget changed over the last three years?"));
    const body = await response.json();
    expect(newsAttempts).toBe(2);
    expect(body.newsSearched).toBe(false);
    expect(body.officialSearched).toBe(true);
    expect(body.answer).toContain("budget");
  });
});
