export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const message = typeof body?.message === "string" ? body.message : "";

  return Response.json({
    reply: message ? `You said: ${message}` : "Send me a message.",
  });
}
