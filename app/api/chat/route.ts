import OpenAI from "openai";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function extractAnswerAndCitations(response: any) {
  const output = Array.isArray(response?.output) ? response.output : [];

  let answer = response?.output_text ?? "";

  const citations: { file_id: string; filename: string }[] = [];

  for (const item of output) {
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

  // Deduplicate by file id and filename
  const seen = new Set<string>();
  const unique = citations.filter((c) => {
    const key = `${c.file_id}:${c.filename}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { answer: (answer || "").trim(), citations: unique };
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
          content:
            "You are MuniGPT. Use file search to answer using the provided municipal documents. If the documents do not support an answer, say you do not have enough information and suggest what to consult. Do not guess. Provide a short answer. Cite the files you relied on.",
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
      include: ["file_search_call.results"],
    });

    const { answer, citations } = extractAnswerAndCitations(response);

    const reply = answer || "I could not find support in the uploaded documents for that question.";

    return Response.json({
      reply,
      citations,
    });
  } catch (e: any) {
    return Response.json({ reply: `Server error: ${e?.message ?? "Unknown error"}` }, { status: 500 });
  }
}
