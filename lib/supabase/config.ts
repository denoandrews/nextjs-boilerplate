export function isSupabasePublicConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()
  );
}

export function isSupabaseAdminConfigured() {
  return Boolean(isSupabasePublicConfigured() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

export function getSupabasePublicConfig() {
  if (!isSupabasePublicConfigured()) {
    throw new Error("Supabase public configuration is missing.");
  }

  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string,
  };
}
