import { afterEach, describe, expect, it, vi } from "vitest";
import { isSupabaseAdminConfigured, isSupabasePublicConfigured } from "./config";

afterEach(() => vi.unstubAllEnvs());

describe("Supabase configuration gates", () => {
  it("keeps public auth disabled when either public value is absent", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    expect(isSupabasePublicConfigured()).toBe(false);
  });

  it("requires the service role for server logging", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    expect(isSupabasePublicConfigured()).toBe(true);
    expect(isSupabaseAdminConfigured()).toBe(false);
  });
});
