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

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:  `
You are MuniGPT, an informational assistant for the Village of Oak Park.

Priority and sources:
1. First use file search using the provided municipal document library.
2. Only if the file search does not support an answer, use web search, but do this automatically- don't make userrs ask.
3. When using web search, you MUST restrict yourself to http://oak-park.us by using a site-limited query in your search behavior and by citing only http://oak-park.us pages.
4. If neither the documents nor oak-park.us provides enough support, say you do not have enough information.

Rules:
- Do not guess.
- Do not provide legal advice.
- Keep answers concise.
- Always include a Sources section.
- Use non-gendered language.

Sources requirements:
- If you used municipal documents, list the document file names.
- If you used the website, list the full oak park.us page URLs.
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
  {
    type: "web_search_preview",
  },
],
    });

    const { answer, citations, webSources } = extractAnswerAndCitations(response);

    const sourcesTextParts: string[] = [];

    if (citations.length) {
      for (const c of citations) sourcesTextParts.push(`- ${c.filename}`);
    }
    if (webSources.length) {
      for (const s of webSources) sourcesTextParts.push(`- ${s.title ?? s.url} (${s.url})`);
    }

    const sourcesText = sourcesTextParts.length ? `\n\nSources:\n${sourcesTextParts.join("\n")}` : "";

    const reply =
      (answer || "I could not find support in the documents or oak-park.us for that question.") + sourcesText;

    return Response.json({
      reply,
      citations,
      webSources,
    });
  } catch (e: any) {
    return Response.json({ reply: `Server error: ${e?.message ?? "Unknown error"}` }, { status: 500 });
  }
}
