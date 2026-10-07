"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SetPasswordForm({ configured }: { configured: boolean }) {
  const router = useRouter();
  const [sessionReady, setSessionReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!configured) return;
    const supabase = createClient();
    let active = true;

    supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError || !data.session) {
        setError("This invitation link is invalid or has expired. Ask your MuniGPT administrator for a new invitation.");
        return;
      }
      setSessionReady(true);
    });

    return () => {
      active = false;
    };
  }, [configured]);

  async function setPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!configured || !sessionReady) return;
    setError("");

    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    const confirmation = String(form.get("passwordConfirmation") || "");
    if (password.length < 12) {
      setError("Use a password with at least 12 characters.");
      return;
    }
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }

    setBusy(true);
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError("Your password could not be saved. Request a new invitation and try again.");
      setBusy(false);
      return;
    }

    router.push("/admin");
    router.refresh();
  }

  return (
    <form className="admin-form" onSubmit={setPassword}>
      <label htmlFor="password">New password</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="new-password"
        minLength={12}
        required
        disabled={!configured || !sessionReady || busy}
      />
      <label htmlFor="passwordConfirmation">Confirm new password</label>
      <input
        id="passwordConfirmation"
        name="passwordConfirmation"
        type="password"
        autoComplete="new-password"
        minLength={12}
        required
        disabled={!configured || !sessionReady || busy}
      />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {!configured ? (
        <p className="form-error" role="alert">Administrator access is not configured for this deployment.</p>
      ) : null}
      <button type="submit" disabled={!configured || !sessionReady || busy}>
        {busy ? "Saving…" : "Save password"}
      </button>
    </form>
  );
}
