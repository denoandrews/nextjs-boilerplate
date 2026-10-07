import OpenAI from "openai";
import { logChatExchange } from "@/lib/chat-logging";
import { getMunicipalityConfig } from "@/lib/municipalities";

export const runtime = "nodejs";

const MAX_MESSAGE_LENGTH = 2_000;
const MAX_HISTORY_MESSAGES = 12;

type ChatRole = "user" | "assistant";

type HistoryMessage = {
  role: ChatRole;
  content: string;
};

type Citation = {
  fileId: string;
  filename: string;
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

function extractCitations(response: OpenAI.Responses.Response): Citation[] {
  const citations = new Map<string, Citation>();

  for (const item of response.output) {
    if (item.type !== "message") continue;

    for (const content of item.content) {
      if (content.type !== "output_text") continue;

      for (const annotation of content.annotations) {
        if (annotation.type !== "file_citation") continue;

        citations.set(annotation.file_id, {
          fileId: annotation.file_id,
          filename: annotation.filename,
        });
      }
    }
  }

  return [...citations.values()];
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

    const history = parseHistory(body.history);
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const model = getModel();

    const response = await client.responses.create({
      model,
      instructions: `
You are MuniGPT, a public-records research assistant for ${municipality.name}.

Use only the records returned by file search. Do not use outside knowledge.

Rules:
1. Answer only when the retrieved records support the answer.
2. Never guess, invent a fact, or imply that a proposal was adopted.
3. Distinguish drafts, agendas, staff recommendations, minutes, ordinances, resolutions, policies, and secondary sources.
4. If the records conflict, explain the conflict.
5. If the records do not establish the answer, say that you could not establish it from the available records.
6. Do not provide legal advice or claim that the answer is an official municipal determination.
7. Keep the answer clear and concise. Do not type a separate Sources section; the application displays citations from the API response.
      `.trim(),
      input: buildInput(history, message),
      tools: [
        {
          type: "file_search",
          vector_store_ids: municipality.vectorStoreIds,
          max_num_results: 8,
        },
      ],
    });

    const answer = response.output_text.trim();
    const citations = extractCitations(response);

    const finalAnswer = answer || "I could not establish an answer from the available records.";
    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId.slice(0, 80) : undefined;
    const anonymousSessionId =
      typeof body.anonymousSessionId === "string" ? body.anonymousSessionId.slice(0, 80) : undefined;
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
        municipality: municipality.name,
        conversationId: logged.conversationId,
        requestId,
      },
      200,
      requestId
    );
  } catch (error: unknown) {
    console.error(`[${requestId}] Chat request failed.`, error);
    return jsonResponse(
      {
        error: "MuniGPT could not complete that request. Please try again.",
        requestId,
      },
      500,
      requestId
    );
  }
}
