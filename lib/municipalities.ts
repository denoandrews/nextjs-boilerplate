import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseAdminConfigured } from "@/lib/supabase/config";

export type MunicipalityConfig = {
  id: string | null;
  slug: string;
  name: string;
  vectorStoreIds: string[];
};

function environmentConfig(): MunicipalityConfig {
  const vectorStoreIds = (process.env.VECTOR_STORE_IDS ?? process.env.VECTOR_STORE_ID ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return {
    id: null,
    slug: process.env.MUNICIPALITY_SLUG?.trim() || "default",
    name: process.env.MUNICIPALITY_NAME?.trim() || "the participating municipality",
    vectorStoreIds,
  };
}

export async function getMunicipalityConfig(slug?: string): Promise<MunicipalityConfig | null> {
  if (!slug || !isSupabaseAdminConfigured()) return environmentConfig();

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("municipalities")
    .select("id, slug, name, vector_store_ids")
    .eq("slug", slug)
    .eq("active", true)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id,
    slug: data.slug,
    name: data.name,
    vectorStoreIds: data.vector_store_ids ?? [],
  };
}
