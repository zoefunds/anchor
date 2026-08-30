"use client";

import { useState } from "react";
import Link from "next/link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
    } finally {
      setLoading(false);
      setSubmitted(true);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-8">
      <Link href="/" className="font-display text-lg font-semibold text-ink-950 dark:text-ink">
        Anchor
      </Link>
      <p className="kicker mt-6 text-seal-500 dark:text-seal-400">Account recovery</p>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
        Reset password
      </h1>

      {submitted ? (
        <p className="mt-10 text-sm text-muted dark:text-muted-dark">
          If an account exists for that email, a reset link is on its way. Check your inbox.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-6">
          <label className="flex flex-col gap-2">
            <span className="field-label">Email</span>
            <input
              className="field-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <button className="btn-primary mt-2" type="submit" disabled={loading}>
            {loading ? "Sending…" : "Send reset link"}
          </button>
        </form>
      )}

      <p className="mt-8 text-sm text-muted dark:text-muted-dark">
        <Link href="/login" className="text-seal-500 hover:underline dark:text-seal-400">
          Back to log in
        </Link>
      </p>
    </main>
  );
}
