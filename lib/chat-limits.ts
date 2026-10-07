import "server-only";

import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseAdminConfigured } from "@/lib/supabase/config";

export type ChatLimitDecision = {
  allowed: boolean;
  reason: "allowed" | "rate_limit" | "monthly_quota" | "unavailable";
  retryAfterSeconds?: number;
  monthlyCount?: number;
  monthlyLimit?: number;
};

type LimitRow = {
  allowed: boolean;
  reason: ChatLimitDecision["reason"];
  retry_after_seconds: number | null;
  monthly_count: number | null;
  monthly_limit: number | null;
};

function requestIdentity(request: Request, anonymousSessionId?: string): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = forwarded || request.headers.get("x-real-ip")?.trim();
  return address || anonymousSessionId?.trim() || "unknown";
}

export function hashRequestIdentity(request: Request, anonymousSessionId?: string): string {
  const salt =
    process.env.RATE_LIMIT_SALT ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.OPENAI_API_KEY ||
    "munigpt-rate-limit";

  return createHash("sha256")
    .update(`${salt}:${requestIdentity(request, anonymousSessionId)}`)
    .digest("hex");
}

export async function reserveChatQuery(input: {
  municipalityId: string | null;
  request: Request;
  anonymousSessionId?: string;
}): Promise<ChatLimitDecision> {
  if (!input.municipalityId || !isSupabaseAdminConfigured()) {
    return { allowed: true, reason: "allowed" };
  }

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("reserve_chat_query", {
      p_municipality_id: input.municipalityId,
      p_key_hash: hashRequestIdentity(input.request, input.anonymousSessionId),
    });

    if (error) throw error;
    const row = (Array.isArray(data) ? data[0] : data) as LimitRow | null;
    if (!row) throw new Error("No quota decision was returned.");

    return {
      allowed: row.allowed,
      reason: row.reason,
      retryAfterSeconds: row.retry_after_seconds ?? undefined,
      monthlyCount: row.monthly_count ?? undefined,
      monthlyLimit: row.monthly_limit ?? undefined,
    };
  } catch (error) {
    console.error("Failed to reserve MuniGPT query capacity.", error);
    // Fail closed so a database incident cannot create an unbounded OpenAI bill.
    return { allowed: false, reason: "unavailable", retryAfterSeconds: 60 };
  }
}
