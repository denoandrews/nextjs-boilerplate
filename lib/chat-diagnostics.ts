import type OpenAI from "openai";

export type ChatResponseDiagnostics = {
  status: string | null;
  reasoningTokens: number;
  searchCount: number;
  incompleteReason: string | null;
  hasOutputText: boolean;
};

function outputText(response: OpenAI.Responses.Response): string {
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type === "output_text" && content.text.trim()) parts.push(content.text.trim());
    }
  }
  return parts.join("\n").trim();
}

/** Counts the model can hide when a reasoning call spends its whole budget and returns no text. */
export function describeChatResponse(response: OpenAI.Responses.Response): ChatResponseDiagnostics {
  const searchCount = (response.output ?? []).filter((item) => item.type === "file_search_call").length;
  return {
    status: response.status ?? null,
    reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    searchCount,
    incompleteReason: response.incomplete_details?.reason ?? null,
    hasOutputText: outputText(response).length > 0,
  };
}

export function logChatDiagnostics(requestId: string, response: OpenAI.Responses.Response): ChatResponseDiagnostics {
  const diagnostics = describeChatResponse(response);
  console.info(`[${requestId}] chat diagnostics ${JSON.stringify(diagnostics)}`);
  return diagnostics;
}
