import "server-only";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isSupabasePublicConfigured } from "@/lib/supabase/config";

export type AdminContext = {
  userId: string;
  municipalityId: string;
  municipalityName: string;
  municipalitySlug: string;
  role: "admin" | "editor" | "viewer";
};

export async function getAdminContext(): Promise<AdminContext | null> {
  if (!isSupabasePublicConfigured()) return null;
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return null;

  const { data, error } = await supabase
    .from("municipality_memberships")
    .select("municipality_id, role, municipalities(name, slug)")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  const municipality = data.municipalities as unknown as { name: string; slug: string } | null;
  if (!municipality) return null;

  return {
    userId,
    municipalityId: data.municipality_id,
    municipalityName: municipality.name,
    municipalitySlug: municipality.slug,
    role: data.role,
  };
}

export async function requireAdminContext() {
  if (!isSupabasePublicConfigured()) redirect("/admin/login?error=not-configured");
  const context = await getAdminContext();
  if (!context) redirect("/admin/login");
  return context;
}
