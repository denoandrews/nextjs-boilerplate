import "server-only";

import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig, isSupabaseAdminConfigured } from "./config";

export function createAdminClient() {
  if (!isSupabaseAdminConfigured()) {
    throw new Error("Supabase service configuration is missing.");
  }

  const { url } = getSupabasePublicConfig();
  return createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY as string, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
