import OpenAI from "openai"; 
import { cookies } from "next/headers";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/* ============================
   Types
============================ */

type ChatRole = "user" | "assistant";

type HistoryMessage = {
  role: ChatRole;
  content: string;
};

/* ============================
   In memory session store
   NOTE: fine for dev, NOT prod
============================ */

const memory = new Map<string, HistoryMessage[]>();

/* ============================
   Helpers
============================ */

function isLikelyPersonLookup(q: string) {
  const s = q.toLowerCase().trim();
  return s.startsWith("who is") || s.startsWith("who's") || s.includes("staff") || s.includes("director");
}

async function getOrCreateSessionId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get("munigpt_sid")?.value;

  if (existing) return existing;

  const sid = crypto.randomUUID();

  jar.set("munigpt_sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 6, // 6 hours
  });

  return sid;
}

function getHistory(sessionId: string): HistoryMessage[] {
  return memory.get(sessionId) ?? [];
}

function setHistory(sessionId: string, history: HistoryMessage[]) {
  // keep last 40 messages (about 20 turns)
  memory.set(sessionId, history.slice(-40));
}

function buildInput(
  systemPrompt: string,
  history: HistoryMessage[],
  userText: string
) {
  return [
    { role: "system" as const, content: systemPrompt },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userText },
  ];
}

/* ============================
   Route
============================ */

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message.trim() : "";

    if (!message) {
      return Response.json({ reply: "Type a question and press Send." });
    }

    if (!process.env.OPENAI_API_KEY) {
      return Response.json({ reply: "Missing OPENAI_API_KEY." }, { status: 500 });
    }

    if (!process.env.VECTOR_STORE_ID) {
      return Response.json({ reply: "Missing VECTOR_STORE_ID." }, { status: 500 });
    }

    const sessionId = await getOrCreateSessionId();
    const history = getHistory(sessionId);

    const baseSystemPrompt = `
You are MuniGPT, an informational assistant for the Village of Oak Park.

Rules:
1. Do not guess.
2. Do not provide legal advice.
3. Keep answers concise.
4. Always include a Sources section.

Sources rules:
- If you used municipal documents, list the document file names.
- If you used the website, list the full oak-park.us page URLs.
`.trim();

    const forceWeb = isLikelyPersonLookup(message);

    /* ============================
       PASS 1: Documents
    ============================ */

    const respDocs = await client.responses.create({
      model: "gpt-4.1-mini",
      input: buildInput(
        `
${baseSystemPrompt}

Pass 1 instructions:
Use file search on the municipal documents.
Answer only if documents support it.
If not found, say "NOT FOUND IN DOCUMENTS".
`.trim(),
        history,
        message
      ),
      tools: [
        {
          type: "file_search",
          vector_store_ids: [process.env.VECTOR_STORE_ID],
          max_num_results: 8,
        },
      ],
    });

    const textDocs = (respDocs.output_text ?? "").trim();

    const docsNotFound =
      !textDocs ||
      textDocs.toLowerCase().includes("not found in documents");

    if (!docsNotFound && !forceWeb) {
      const reply = `PASS 1 USED\n\n${textDocs}`;
      setHistory(sessionId, [...history, { role: "user", content: message }, { role: "assistant", content: reply }]);
      return Response.json({ reply });
    }

    /* ============================
       PASS 2: Website
    ============================ */

    const respWeb = await client.responses.create({
      model: "gpt-4.1-mini",
      input: buildInput(
        `
${baseSystemPrompt}

Pass 2 instructions:
You must use web search.
Only oak-park.us pages are allowed.
Include URLs in Sources.
`.trim(),
        history,
        `site:oak-park.us ${message}`
      ),
      tools: [{ type: "web_search_preview" }],
    });

    const textWeb = (respWeb.output_text ?? "").trim();

    const reply = textWeb
      ? `PASS 2 USED\n\n${textWeb}`
      : "PASS 2 USED\n\nI could not find an answer in municipal documents or on oak-park.us.";

    setHistory(sessionId, [...history, { role: "user", content: message }, { role: "assistant", content: reply }]);

    return Response.json({ reply });
  } catch (err: any) {
    return Response.json(
      { reply: `Server error: ${err?.message ?? "Unknown error"}` },
      { status: 500 }
    );
  }
}
