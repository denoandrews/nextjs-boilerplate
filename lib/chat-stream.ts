export type ChatStreamResult = {
  answer?: string;
  error?: string;
  citations?: unknown;
  newsSearched?: boolean;
  officialSearched?: boolean;
  municipality?: string;
  conversationId?: string;
  requestId?: string;
};

/** Reads `data: {...}` events from a chat progress stream. The last result or error wins. */
export async function readChatEvents(
  stream: ReadableStream<Uint8Array>,
  onProgress?: (message: string) => void,
): Promise<ChatStreamResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: ChatStreamResult = {};
  const consume = (block: string) => {
    const line = block.split("\n").find((entry) => entry.startsWith("data:"));
    if (!line) return;
    let event: { type?: string; message?: string; error?: string };
    try {
      event = JSON.parse(line.slice(5).trim()) as { type?: string; message?: string; error?: string };
    } catch {
      return;
    }
    if (event.type === "progress" && typeof event.message === "string") onProgress?.(event.message);
    if (event.type === "result" || event.type === "error") result = event;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) consume(block);
  }
  if (buffer.trim()) consume(buffer);
  return result;
}
