import OpenAI from "openai";

export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message : "";

    if (!process.env.OPENAI_API_KEY) {
      return Response.json(
        { reply: "Missing OPENAI_API_KEY in Vercel environment variables." },
        { status: 500 }
      );
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
            "You are MuniGPT, a municipal information assistant. Be concise. If you are unsure, say so. Do not provide legal advice. Encourage users to verify with official records.",
        },
        { role: "user", content: message },
      ],
    });

    return Response.json({ reply: response.output_text ?? "No output text returned." });
  } catch (e: any) {
    return Response.json({ reply: `Server error: ${e?.message ?? "Unknown error"}` }, { status: 500 });
  }
}
