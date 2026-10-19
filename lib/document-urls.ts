import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseAdminConfigured } from "@/lib/supabase/config";
import { safeHttpsUrl } from "@/lib/source-links";

export async function documentSourceUrls(
  municipalityId: string | null,
  fileIds: string[]
): Promise<Map<string, string>> {
  const ids = [...new Set(fileIds.filter((id) => id.startsWith("file-")))];
  if (!municipalityId || ids.length === 0 || !isSupabaseAdminConfigured()) return new Map();

  try {
    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("documents")
      .select("openai_file_id, external_url")
      .eq("municipality_id", municipalityId)
      .in("openai_file_id", ids);
    if (error) throw error;

    const urls = new Map<string, string>();
    for (const row of data ?? []) {
      if (typeof row.openai_file_id !== "string" || typeof row.external_url !== "string") continue;
      const safe = safeHttpsUrl(row.external_url);
      if (safe) urls.set(row.openai_file_id, safe);
    }
    return urls;
  } catch (error) {
    console.error("Could not load document source URLs.", error);
    return new Map();
  }
}
