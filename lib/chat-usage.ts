import "server-only";

import OpenAI from "openai";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseAdminConfigured } from "@/lib/supabase/config";

export type ChatUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  fileSearchCalls: number;
  estimatedCostMicrousd: number;
};

type UsageEvent = ChatUsage & {
  municipalityId: string | null;
  requestId: string;
  model: string;
};

function envRate(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function estimateCostMicrousd(input: Omit<ChatUsage, "estimatedCostMicrousd">): number {
  const cachedTokens = Math.min(input.cachedInputTokens, input.inputTokens);
  const uncachedTokens = input.inputTokens - cachedTokens;

  // Rates are USD per million tokens and USD per thousand tool calls. In
  // microdollars, the token calculation simplifies to tokens * rate.
  const tokenCost =
    uncachedTokens * envRate("OPENAI_INPUT_COST_PER_MILLION", 0.4) +
    cachedTokens * envRate("OPENAI_CACHED_INPUT_COST_PER_MILLION", 0.1) +
    input.outputTokens * envRate("OPENAI_OUTPUT_COST_PER_MILLION", 1.6);
  const fileSearchCost =
    input.fileSearchCalls * envRate("OPENAI_FILE_SEARCH_COST_PER_THOUSAND", 2.5) * 1_000;

  return Math.round(tokenCost + fileSearchCost);
}

export function extractChatUsage(response: OpenAI.Responses.Response): ChatUsage {
  const inputTokens = response.usage?.input_tokens ?? 0;
  const cachedInputTokens = response.usage?.input_tokens_details?.cached_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const totalTokens = response.usage?.total_tokens ?? inputTokens + outputTokens;
  const fileSearchCalls = response.output.filter((item) => item.type === "file_search_call").length;
  const rawUsage = {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens,
    fileSearchCalls,
  };

  return { ...rawUsage, estimatedCostMicrousd: estimateCostMicrousd(rawUsage) };
}

export async function logUsageEvent(input: UsageEvent): Promise<void> {
  if (!input.municipalityId || !isSupabaseAdminConfigured()) return;

  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from("usage_events").insert({
      municipality_id: input.municipalityId,
      request_id: input.requestId,
      model: input.model,
      input_tokens: input.inputTokens,
      cached_input_tokens: input.cachedInputTokens,
      output_tokens: input.outputTokens,
      total_tokens: input.totalTokens,
      file_search_calls: input.fileSearchCalls,
      estimated_cost_microusd: input.estimatedCostMicrousd,
    });

    if (error) throw error;
  } catch (error) {
    console.error(`[${input.requestId}] Failed to save OpenAI usage.`, error);
  }
}
