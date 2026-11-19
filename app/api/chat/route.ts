import OpenAI from "openai";
import { clarifyLevyAnswer } from "@/lib/answer-quality";
import { newspaperDomains, extractCitedAnswer } from "@/lib/news-search";
import { resolveChatModel } from "@/lib/chat-model";
import { buildChatInstructions, getMaxOutputTokens, getRetryOutputTokens } from "@/lib/chat-instructions";
import { logChatDiagnostics } from "@/lib/chat-diagnostics";
import { fileSearchFilters, fileSearchTool, loadAttributeIndex } from "@/lib/file-search";
import { researchModeEnabled, runResearchTurn } from "@/lib/research";
import { webPassEnabled, webSearchDomains } from "@/lib/web-sources";
import { turnLanguageDirective } from "@/lib/ui-locale";
import { OPENAI_MAX_RETRIES, OPENAI_REQUEST_TIMEOUT_MS, requestTimedOut } from "@/lib/chat-request";
import { reserveChatQuery } from "@/lib/chat-limits";
import { logChatExchange } from "@/lib/chat-logging";
import { addChatUsage, extractChatUsage, logUsageEvent } from "@/lib/chat-usage";
import { documentSourceUrls } from "@/lib/document-urls";
import { withStoredSourceUrls } from "@/lib/source-links";
import { getMunicipalityConfig } from "@/lib/municipalities";

export const runtime = "nodejs";
// Next.js reads this literal. Keep it equal to CHAT_MAX_DURATION_SECONDS.
export const maxDuration = 180;

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
  streamProgress?: unknown;
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

function eventStream(requestId: string, work: (send: (event: Record<string, unknown>) => void) => Promise<void>) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        await work(send);
      } catch (error: unknown) {
        console.error(`[${requestId}] Chat stream failed.`, error);
        send({
          type: "error",
          error: requestTimedOut(error)
            ? "That search took too long. Please try again."
            : "MuniGPT could not complete that request. Please try again.",
          requestId,
        });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Request-ID": requestId,
    },
  });
}

function buildInput(history: HistoryMessage[], userText: string, attributeIndex?: string | null) {
  return [
    ...history.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    { role: "developer" as const, content: turnLanguageDirective(userText) },
    ...(attributeIndex ? [{ role: "developer" as const, content: attributeIndex }] : []),
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
    // The forced website pass can be turned off. The quick path then keeps newspapers only.
    const searchDomains = webPassEnabled(municipality.slug) ? webSearchDomains(municipality.slug) : newsDomains;
    // Domain-filtered web search needs a model newer than GPT-4.1 Mini.
    // gpt-5.4-mini stays the default there. A municipality with no reasoning-capable
    // default is moved to that model so medium reasoning can be sent.
    const { model, reasoning } = resolveChatModel({ newsEnabled: newsDomains.length > 0 || searchDomains.length > 0 });
    const historyText = history.map((item) => item.content).join("\n");
    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId.slice(0, 80) : undefined;

    const publish = async (result: {
      answer: string;
      citations: { fileId: string; filename: string; url?: string; marker?: string }[];
      newsSearched: boolean;
      officialSearched: boolean;
      usage: ReturnType<typeof extractChatUsage>;
    }) => {
      const storedUrls = await documentSourceUrls(
        municipality.id,
        result.citations.map((citation) => citation.fileId),
      );
      const citations = withStoredSourceUrls(result.citations, storedUrls);
      await logUsageEvent({
        municipalityId: municipality.id,
        requestId,
        model,
        ...result.usage,
      });
      const finalAnswer = clarifyLevyAnswer(message, result.answer, historyText) || "I could not establish an answer from the available records.";
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
      return {
        answer: finalAnswer,
        citations,
        newsSearched: result.newsSearched,
        officialSearched: result.officialSearched,
        municipality: municipality.name,
        conversationId: logged.conversationId,
        requestId,
      };
    };

    if (researchModeEnabled(municipality.slug)) {
      const run = (onProgress?: (status: string) => void) => runResearchTurn({
        client,
        slug: municipality.slug,
        municipalityName: municipality.name,
        vectorStoreIds: municipality.vectorStoreIds,
        question: message,
        history,
        model,
        reasoning,
        signal: req.signal,
        requestId,
        onProgress,
      });
      if (body.streamProgress === true) {
        return eventStream(requestId, async (send) => {
          const researched = await run((status) => send({ type: "progress", message: status }));
          send({ type: "result", ...(await publish(researched)) });
        });
      }
      return jsonResponse(await publish(await run()), 200, requestId);
    }
    const filters = fileSearchFilters(message, municipality.slug);
    const attributeIndex = await loadAttributeIndex(client, {
      slug: municipality.slug,
      vectorStoreIds: municipality.vectorStoreIds,
      question: message,
      filters,
      signal: req.signal,
      requestId,
    });

    const requestBody = {
      model,
      max_output_tokens: getMaxOutputTokens(model, reasoning?.effort),
      ...(reasoning ? { reasoning } : {}),
      instructions: buildChatInstructions({
        municipalityName: municipality.name,
        slug: municipality.slug,
        newsEnabled: newsDomains.length > 0,
        question: message,
      }),
      input: buildInput(history, message, attributeIndex),
      include: ["file_search_call.results" as const],
      tools: [
        fileSearchTool(municipality.vectorStoreIds, filters),
        ...(searchDomains.length ? [{
          type: "web_search" as const,
          filters: { allowed_domains: searchDomains },
          external_web_access: true,
          search_context_size: "low" as const,
        }] : []),
      ],
    };

    const response = await client.responses.create(requestBody, { signal: req.signal });
    const firstDiagnostics = logChatDiagnostics(requestId, response);
    let extracted = extractCitedAnswer(response, searchDomains.length > 0 || newsDomains.length > 0, { slug: municipality.slug });
    let usage = extractChatUsage(response, model);

    // A reasoning model can spend the whole output budget before it writes any
    // text. One low-effort retry is cheaper than returning an empty answer.
    if (!extracted.answer.trim()) {
      console.info(
        `[${requestId}] Empty answer (status=${firstDiagnostics.status ?? "unknown"}, incomplete=${firstDiagnostics.incompleteReason ?? "none"}, reasoningTokens=${firstDiagnostics.reasoningTokens}, searchCount=${firstDiagnostics.searchCount}). Retrying once at low effort.`,
      );
      try {
        const retry = await client.responses.create(
          {
            ...requestBody,
            max_output_tokens: getRetryOutputTokens(model, reasoning?.effort),
            ...(reasoning ? { reasoning: { effort: "low" as const } } : {}),
          },
          { signal: req.signal },
        );
        const retryDiagnostics = logChatDiagnostics(requestId, retry);
        const retryExtracted = extractCitedAnswer(retry, searchDomains.length > 0 || newsDomains.length > 0, { slug: municipality.slug });
        usage = addChatUsage(usage, extractChatUsage(retry, model), model);
        if (retryExtracted.answer.trim()) {
          extracted = retryExtracted;
        } else {
          console.info(
            `[${requestId}] Low-effort retry also returned no text (status=${retryDiagnostics.status ?? "unknown"}, incomplete=${retryDiagnostics.incompleteReason ?? "none"}).`,
          );
        }
      } catch (error) {
        if (requestTimedOut(error)) throw error;
        console.error(`[${requestId}] Empty-answer retry failed.`, error);
      }
    }

    return jsonResponse(await publish({
      answer: extracted.answer,
      citations: extracted.citations,
      newsSearched: extracted.newsSearched,
      officialSearched: extracted.citations.some((citation) => citation.marker?.startsWith("[Official")),
      usage,
    }), 200, requestId);
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

