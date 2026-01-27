import OpenAI from "openai";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function extractAnswerAndCitations(response: any) {
  const output = Array.isArray(response?.output) ? response.output : [];
  let answer = response?.output_text ?? "";

  const citations: { file_id: string; filename: string }[] = [];
  const webSources: { title?: string; url?: string }[] = [];

  for (const item of output) {
    // Web search call outputs can appear as tool calls in the output array
    if (item?.type === "web_search_call") {
      const sources = item?.action?.sources;
      if (Array.isArray(sources)) {
        for (const s of sources) {
          webSources.push({ title: s?.title, url: s?.url });
        }
      }
    }

    if (item?.type !== "message") continue;

    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type !== "output_text") continue;

      if (!answer && typeof part?.text === "string") {
        answer = part.text;
      }

      const annotations = Array.isArray(part?.annotations) ? part.annotations : [];
      for (const ann of annotations) {
        if (ann?.type === "file_citation") {
          citations.push({
            file_id: ann.file_id,
            filename: ann.filename,
          });
        }
      }
    }
  }

  // Deduplicate citations
  const seenFiles = new Set<string>();
  const uniqueCitations = citations.filter((c) => {
    const key = `${c.file_id}:${c.filename}`;
    if (seenFiles.has(key)) return false;
    seenFiles.add(key);
    return true;
  });

  // Deduplicate web sources
  const seenUrls = new Set<string>();
  const uniqueWebSources = webSources.filter((s) => {
    const url = s.url ?? "";
    if (!url) return false;
    if (seenUrls.has(url)) return false;
    seenUrls.add(url);
    return true;
  });

  return { answer: (answer || "").trim(), citations: uniqueCitations, webSources: uniqueWebSources };
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

    const systemPrompt = `
You are MuniGPT, an informational assistant for the Village of Oak Park.

Rules:
1. Do not guess.
2. Do not provide legal advice.
3. Keep answers concise.
4. Always include a Sources section.

If you used municipal documents, list the document file names in Sources.
If you used the website, list the full oak-park.us page URLs in Sources.
`;

    // Pass 1: file search
    const resp1 = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt + "\nFirst try the municipal document library using file search." },
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

    const text1 = (resp1.output_text ?? "").trim();

    // Simple heuristic: if it says it cannot find info, do Pass 2
    const looksLikeNoAnswer =
      !text1 ||
      text1.toLowerCase().includes("do not have enough information") ||
      text1.toLowerCase().includes("did not return any information") ||
      text1.toLowerCase().includes("not return any information") ||
      text1.toLowerCase().includes("not found");

    if (!looksLikeNoAnswer) {
      return Response.json({ reply: text1 });
    }

    // Pass 2: web search forced with site restriction in the query
    const webQuery = `site:oak-park.us ${message}`;

    const resp2 = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            systemPrompt +
            "\nThe municipal document library did not contain the answer. Now you must use web search and only rely on oak-park.us pages. Include oak-park.us URLs in Sources.",
        },
        { role: "user", content: webQuery },
      ],
      tools: [{ type: "web_search_preview" }],
      tool_choice: "auto",
    });

    const text2 = (resp2.output_text ?? "").trim();

    return Response.json({
      reply: text2 || "I could not find an answer in the municipal documents or on oak-park.us.",
    });
  } catch (e: any) {
    return Response.json({ reply: `Server error: ${e?.message ?? "Unknown error"}` }, { status: 500 });
  }
}
