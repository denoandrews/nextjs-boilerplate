import OpenAI from "openai";
import { newspaperDomains, extractCitedAnswer } from "@/lib/news-search";
import { buildChatInstructions, getMaxOutputTokens } from "@/lib/chat-instructions";
import { OPENAI_MAX_RETRIES, OPENAI_REQUEST_TIMEOUT_MS, requestTimedOut } from "@/lib/chat-request";
import { reserveChatQuery } from "@/lib/chat-limits";
import { logChatExchange } from "@/lib/chat-logging";
import { extractChatUsage, logUsageEvent } from "@/lib/chat-usage";
import { documentSourceUrls } from "@/lib/document-urls";
import { withStoredSourceUrls } from "@/lib/source-links";
import { getMunicipalityConfig } from "@/lib/municipalities";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_HISTORY_MESSAGES = 12;

type ChatRole = "user" | "assistant";

type HistoryMessage = {
  role: ChatRole;
  content: string;
};

type ChatRequest = {
  message?: unknown;
  history?: unknown;
  municipalitySlug?: unknown;
  conversationId?: unknown;
  anonymousSessionId?: unknown;
};

function jsonResponse(body: unknown, status: number, requestId: string) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Request-ID": requestId,
    },
  });
}

function parseHistory(value: unknown): HistoryMessage[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is { role: ChatRole; content: string } => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Record<string, unknown>;
      return (
        (candidate.role === "user" || candidate.role === "assistant") &&
        typeof candidate.content === "string" &&
        candidate.content.trim().length > 0
      );
    })
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => ({
      role: item.role,
      content: item.content.trim().slice(0, MAX_MESSAGE_LENGTH),
    }));
}

function getModel(): string {
  return process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";
}

function buildInput(history: HistoryMessage[], userText: string) {
  return [
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    { role: "user" as const, content: userText },
  ];
}

export async function POST(req: Request) {
  const requestId = crypto.randomUUID();

  try {
    const body = (await req.json().catch(() => ({}))) as ChatRequest;
    const message = typeof body.message === "string" ? body.message.trim() : "";

    if (!message) {
      return jsonResponse({ error: "Type a question and press Send.", requestId }, 400, requestId);
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
      return jsonResponse(
        {
          error: `Questions must be ${MAX_MESSAGE_LENGTH.toLocaleString()} characters or fewer.`,
          requestId,
        },
        400,
        requestId
      );
    }

    if (!process.env.OPENAI_API_KEY) {
      console.error(`[${requestId}] OPENAI_API_KEY is not configured.`);
      return jsonResponse({ error: "MuniGPT is not configured.", requestId }, 503, requestId);
    }

    const municipalitySlug =
      typeof body.municipalitySlug === "string" ? body.municipalitySlug.trim().slice(0, 80) : undefined;
    const municipality = await getMunicipalityConfig(municipalitySlug);

    if (!municipality) {
      return jsonResponse({ error: "Municipality not found.", requestId }, 404, requestId);
    }

    if (municipality.vectorStoreIds.length === 0) {
      console.error(`[${requestId}] No vector store is configured.`);
      return jsonResponse({ error: "MuniGPT is not configured.", requestId }, 503, requestId);
    }

    const anonymousSessionId =
      typeof body.anonymousSessionId === "string" ? body.anonymousSessionId.slice(0, 80) : undefined;
    const limitDecision = await reserveChatQuery({
      municipalityId: municipality.id,
      request: req,
      anonymousSessionId,
    });

    if (!limitDecision.allowed) {
      const monthlyQuotaReached = limitDecision.reason === "monthly_quota";
      const unavailable = limitDecision.reason === "unavailable";
      const response = jsonResponse(
        {
          error: monthlyQuotaReached
            ? "This municipality has reached its monthly research limit."
            : unavailable
              ? "MuniGPT is temporarily unavailable. Please try again shortly."
              : "Too many questions were submitted. Please wait a moment and try again.",
          requestId,
        },
        unavailable ? 503 : 429,
        requestId
      );
      if (limitDecision.retryAfterSeconds) {
        response.headers.set("Retry-After", String(limitDecision.retryAfterSeconds));
      }
      return response;
    }

    const history = parseHistory(body.history);
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: OPENAI_REQUEST_TIMEOUT_MS,
      maxRetries: OPENAI_MAX_RETRIES,
    });
    const newsDomains = newspaperDomains(municipality.slug);
    // Domain-filtered search requires a newer model than GPT-4.1 Mini.
    const model = newsDomains.length ? "gpt-5.4-mini" : getModel();

    const response = await client.responses.create(
      {
        model,
        max_output_tokens: getMaxOutputTokens(model),
        ...(newsDomains.length ? { reasoning: { effort: "none" as const } } : {}),
        instructions: buildChatInstructions({
          municipalityName: municipality.name,
          slug: municipality.slug,
          newsEnabled: newsDomains.length > 0,
        }),
        input: buildInput(history, message),
        include: ["file_search_call.results"],
        tools: [
          {
            type: "file_search",
            vector_store_ids: municipality.vectorStoreIds,
            max_num_results: 16,
          },
          ...(newsDomains.length ? [{
            type: "web_search" as const,
            filters: { allowed_domains: newsDomains },
            external_web_access: true,
            search_context_size: "low" as const,
          }] : []),
        ],
      },
      { signal: req.signal }
    );

    const extracted = extractCitedAnswer(response, newsDomains.length > 0, { slug: municipality.slug });
    const storedUrls = await documentSourceUrls(
      municipality.id,
      extracted.citations.map((citation) => citation.fileId)
    );
    const citations = withStoredSourceUrls(extracted.citations, storedUrls);
    const { answer, newsSearched } = extracted;
    const usage = extractChatUsage(response, model);

    await logUsageEvent({
      municipalityId: municipality.id,
      requestId,
      model,
      ...usage,
    });

    const finalAnswer = answer || "I could not establish an answer from the available records.";
    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId.slice(0, 80) : undefined;
    const logged = await logChatExchange({
      municipalityId: municipality.id,
      conversationId,
      anonymousSessionId,
      question: message,
      answer: finalAnswer,
      citations,
      requestId,
      model,
    });

    return jsonResponse(
      {
        answer: finalAnswer,
        citations,
        newsSearched,
        municipality: municipality.name,
        conversationId: logged.conversationId,
        requestId,
      },
      200,
      requestId
    );
  } catch (error: unknown) {
    console.error(`[${requestId}] Chat request failed.`, error);
    const timedOut = requestTimedOut(error);
    return jsonResponse(
      {
        error: timedOut
          ? "That search took too long. Please try again."
          : "MuniGPT could not complete that request. Please try again.",
        requestId,
      },
      timedOut ? 504 : 500,
      requestId
    );
  }
}

