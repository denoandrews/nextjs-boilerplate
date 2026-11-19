import "server-only";

import OpenAI from "openai";
import { modelSupportsReasoning } from "@/lib/chat-model";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseAdminConfigured } from "@/lib/supabase/config";

export type ChatUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  fileSearchCalls: number;
  webSearchCalls?: number;
  reasoningTokens?: number;
  incompleteReason?: string | null;
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

export function estimateCostMicrousd(input: Omit<ChatUsage, "estimatedCostMicrousd">, model?: string): number {
  const cachedTokens = Math.min(input.cachedInputTokens, input.inputTokens);
  const uncachedTokens = input.inputTokens - cachedTokens;

  // Rates are USD per million tokens and USD per thousand tool calls. In
  // microdollars, the token calculation simplifies to tokens * rate.
  // gpt-5.4-mini rates. Other reasoning models use the same card until a model-specific rate is set.
  const reasoningModel = Boolean(model && modelSupportsReasoning(model));
  const tokenCost =
    uncachedTokens * envRate("OPENAI_INPUT_COST_PER_MILLION", reasoningModel ? 0.75 : 0.4) +
    cachedTokens * envRate("OPENAI_CACHED_INPUT_COST_PER_MILLION", reasoningModel ? 0.075 : 0.1) +
    input.outputTokens * envRate("OPENAI_OUTPUT_COST_PER_MILLION", reasoningModel ? 4.5 : 1.6);
  const fileSearchCost =
    input.fileSearchCalls * envRate("OPENAI_FILE_SEARCH_COST_PER_THOUSAND", 2.5) * 1_000;

  const webSearchCost = (input.webSearchCalls ?? 0) * envRate("OPENAI_WEB_SEARCH_COST_PER_THOUSAND", 10) * 1_000;
  return Math.round(tokenCost + fileSearchCost + webSearchCost);
}

export function extractChatUsage(response: OpenAI.Responses.Response, model?: string): ChatUsage {
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
    webSearchCalls: response.output.filter((item) => item.type === "web_search_call").length,
    reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens ?? 0,
    incompleteReason: response.incomplete_details?.reason ?? null,
  };

  return { ...rawUsage, estimatedCostMicrousd: estimateCostMicrousd(rawUsage, model) };
}

export function addChatUsage(left: ChatUsage, right: ChatUsage, model?: string): ChatUsage {
  const merged = {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    fileSearchCalls: left.fileSearchCalls + right.fileSearchCalls,
    webSearchCalls: (left.webSearchCalls ?? 0) + (right.webSearchCalls ?? 0),
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    incompleteReason: left.incompleteReason ?? right.incompleteReason ?? null,
  };
  return { ...merged, estimatedCostMicrousd: estimateCostMicrousd(merged, model) };
}

export async function logUsageEvent(input: UsageEvent): Promise<void> {
  if (!input.municipalityId || !isSupabaseAdminConfigured()) return;

  try {
    const supabase = createAdminClient();
    const row = {
      municipality_id: input.municipalityId,
      request_id: input.requestId,
      model: input.model,
      input_tokens: input.inputTokens,
      cached_input_tokens: input.cachedInputTokens,
      output_tokens: input.outputTokens,
      total_tokens: input.totalTokens,
      file_search_calls: input.fileSearchCalls,
      estimated_cost_microusd: input.estimatedCostMicrousd,
      reasoning_tokens: input.reasoningTokens ?? 0,
      incomplete_reason: input.incompleteReason ?? null,
    };
    let { error } = await supabase.from("usage_events").insert(row);
    if (error && /reasoning_tokens|incomplete_reason|schema cache/i.test(error.message)) {
      const legacy = {
        municipality_id: row.municipality_id,
        request_id: row.request_id,
        model: row.model,
        input_tokens: row.input_tokens,
        cached_input_tokens: row.cached_input_tokens,
        output_tokens: row.output_tokens,
        total_tokens: row.total_tokens,
        file_search_calls: row.file_search_calls,
        estimated_cost_microusd: row.estimated_cost_microusd,
      };
      ({ error } = await supabase.from("usage_events").insert(legacy));
    }

    if (error) throw error;
  } catch (error) {
    console.error(`[${input.requestId}] Failed to save OpenAI usage.`, error);
  }
}

