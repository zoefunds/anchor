"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function VerifyRequiredPage() {
  const router = useRouter();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/verify-email", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to send verification email");
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-8">
      <Link href="/" className="font-display text-lg font-semibold text-ink-950 dark:text-ink">
        Anchor
      </Link>
      <p className="kicker mt-6 text-seal-500 dark:text-seal-400">One more step</p>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
        Verify your email
      </h1>
      <p className="mt-4 text-sm text-muted dark:text-muted-dark">
        We sent a verification link when you signed up. Click it to unlock the dashboard.
        You can't file or review cases until your email is confirmed.
      </p>

      {error && <p className="mt-4 text-sm text-status-undetermined">{error}</p>}
      {sent && <p className="mt-4 text-sm text-status-active">Verification email sent. Check your inbox.</p>}

      <div className="mt-8 flex gap-4">
        <button className="btn-primary" onClick={resend} disabled={sending}>
          {sending ? "Sending…" : "Resend link"}
        </button>
        <button
          onClick={logout}
          className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
        >
          Log out
        </button>
      </div>
    </main>
  );
}
