"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

export default function ResetPasswordPage() {
  const params = useParams();
  const token = params.token as string;
  const router = useRouter();

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "reset failed");
      router.push("/cases");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-8">
      <Link href="/" className="font-display text-lg font-semibold text-ink-950 dark:text-ink">
        Anchor
      </Link>
      <p className="kicker mt-6 text-seal-500 dark:text-seal-400">Account recovery</p>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
        Set a new password
      </h1>

      <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-6">
        <label className="flex flex-col gap-2">
          <span className="field-label">New password</span>
          <input
            className="field-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>

        {error && <p className="text-sm text-status-undetermined">{error}</p>}

        <button className="btn-primary mt-2" type="submit" disabled={loading}>
          {loading ? "Resetting…" : "Reset password"}
        </button>
      </form>
    </main>
  );
}
