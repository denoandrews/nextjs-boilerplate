import { isSupabasePublicConfigured } from "@/lib/supabase/config";
import { SetPasswordForm } from "./set-password-form";

export default function SetPasswordPage() {
  const configured = isSupabasePublicConfigured();

  return (
    <main className="admin-shell admin-login-shell">
      <section className="admin-card narrow">
        <p className="eyebrow">Municipal administration</p>
        <h1>Create your password</h1>
        <p>Finish activating your invited MuniGPT administrator account.</p>
        <SetPasswordForm configured={configured} />
      </section>
    </main>
  );
}
