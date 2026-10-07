"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="button-secondary"
      type="button"
      onClick={async () => {
        await createClient().auth.signOut();
        router.push("/admin/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
