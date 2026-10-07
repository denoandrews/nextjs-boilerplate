import { redirect } from "next/navigation";
import { getAdminContext } from "@/lib/admin-auth";
import { isSupabasePublicConfigured } from "@/lib/supabase/config";
import { LoginForm } from "./login-form";

export default async function AdminLoginPage() {
  if (await getAdminContext()) redirect("/admin");
  const configured = isSupabasePublicConfigured();

  return (
    <main className="admin-shell admin-login-shell">
      <section className="admin-card narrow">
        <p className="eyebrow">Municipal administration</p>
        <h1>MuniGPT sign in</h1>
        <p>Access is limited to invited municipal staff.</p>
        <LoginForm configured={configured} />
      </section>
    </main>
  );
}
