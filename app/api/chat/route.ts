import OpenAI from "openai";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function isLikelyPersonLookup(q: string) {
  const s = q.toLowerCase().trim();
  return s.startsWith("who is") || s.startsWith("who's") || s.includes("staff") || s.includes("director");
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message.trim() : "";

    if (!process.env.OPENAI_API_KEY) {
      return Response.json({ reply: "Missing OPENAI_API_KEY in server environment." }, { status: 500 });
    }
    if (!process.env.VECTOR_STORE_ID) {
      return Response.json({ reply: "Missing VECTOR_STORE_ID in server environment." }, { status: 500 });
    }
    if (!message) {
      return Response.json({ reply: "Type a question and press Send." });
    }

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
`;

    const forceWeb = isLikelyPersonLookup(message);

    // Pass 1: municipal documents
    const respDocs = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            baseSystemPrompt +
            `
Pass 1 instructions:
Use file search on the municipal documents. Answer only if the documents support it.
If the documents do not support it, say "NOT FOUND IN DOCUMENTS" and still include Sources.
`,
        },
        { role: "user", content: message },
      ],
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
      textDocs.toLowerCase().includes("not found in documents") ||
      textDocs.toLowerCase().includes("do not contain any information") ||
      textDocs.toLowerCase().includes("do not have enough information");

    // If docs answered and this is not a person lookup, return it
    if (!docsNotFound && !forceWeb) {
      return Response.json({ reply: `PASS 1 USED\n\n${textDocs}` });
    }

    // Pass 2: website search, restricted by query and rules
    const webQuery = `site:oak-park.us ${message}`;

    const respWeb = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            baseSystemPrompt +
            `
Pass 2 instructions:
You must use web search now.
You must rely only on oak-park.us pages.
Include at least one oak-park.us URL in Sources if you provide an answer.
If you cannot find it on oak-park.us, say that clearly and include Sources.
`,
        },
        { role: "user", content: webQuery },
      ],
      tools: [{ type: "web_search_preview" }],
    });

    const textWeb = (respWeb.output_text ?? "").trim();

    if (!textWeb) {
      return Response.json({
        reply: "PASS 2 USED\n\nI could not find an answer in the municipal documents or on oak-park.us.",
      });
    }

    return Response.json({ reply: `PASS 2 USED\n\n${textWeb}` });
  } catch (e: any) {
    return Response.json({ reply: `Server error: ${e?.message ?? "Unknown error"}` }, { status: 500 });
  }
}
