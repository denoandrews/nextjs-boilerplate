/**
 * Chat model and reasoning effort.
 *
 * Oak Park already uses gpt-5.4-mini, which accepts reasoning effort
 * `none | low | medium | high | xhigh` (not `minimal`). gpt-4.1-mini does not
 * accept a reasoning effort. An explicit model pin is kept either way. The
 * hardcoded non-reasoning fallback is replaced so the default effort can be sent.
 */

export const REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

/** Reasoning-capable model used for newspaper search and for the non-reasoning fallback. */
export const DEFAULT_REASONING_MODEL = "gpt-5.4-mini";

const REASONING_MODEL_PATTERN = /^(?:gpt-5|o[134])(?:[.-]|$)/i;

export function modelSupportsReasoning(model: string): boolean {
  return REASONING_MODEL_PATTERN.test(model.trim());
}

export function reasoningEffortFromEnv(
  raw: string | undefined = process.env.MUNIGPT_REASONING_EFFORT,
): ReasoningEffort {
  const value = raw?.trim().toLowerCase();
  if (value && (REASONING_EFFORTS as readonly string[]).includes(value)) return value as ReasoningEffort;
  return DEFAULT_REASONING_EFFORT;
}

export function resolveChatModel(input: { newsEnabled: boolean }): {
  model: string;
  reasoning?: { effort: ReasoningEffort };
} {
  const explicit = process.env.MUNIGPT_CHAT_MODEL?.trim() || "";
  const legacy = process.env.OPENAI_MODEL?.trim() || "";
  const fallback = input.newsEnabled ? DEFAULT_REASONING_MODEL : legacy || "gpt-4.1-mini";
  let model = explicit || fallback;
  const effort = reasoningEffortFromEnv();
  const pinned = explicit.length > 0 || (!input.newsEnabled && legacy.length > 0);

  if (!modelSupportsReasoning(model)) {
    if (pinned) return { model };
    model = DEFAULT_REASONING_MODEL;
  }

  return { model, reasoning: { effort } };
}
