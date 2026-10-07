"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function LoginForm({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: String(form.get("email") || ""),
      password: String(form.get("password") || ""),
    });

    if (authError) {
      setError("Sign-in failed. Check your email and password.");
      setBusy(false);
      return;
    }
    router.push("/admin");
    router.refresh();
  }

  return (
    <form className="admin-form" onSubmit={login}>
      <label htmlFor="email">Work email</label>
      <input id="email" name="email" type="email" autoComplete="email" required disabled={!configured} />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" autoComplete="current-password" required disabled={!configured} />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!configured ? (
        <p className="form-error" role="alert">Administrator access is not configured for this deployment.</p>
      ) : null}
      <button type="submit" disabled={busy || !configured}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
