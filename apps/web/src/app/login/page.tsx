"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "login failed");
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
      <p className="kicker mt-6 text-seal-500 dark:text-seal-400">Welcome back</p>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
        Log in
      </h1>

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
        <label className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="field-label">Password</span>
            <Link href="/forgot-password" className="text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400">
              Forgot password?
            </Link>
          </div>
          <input
            className="field-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {error && <p className="text-sm text-status-undetermined">{error}</p>}

        <button className="btn-primary mt-2" type="submit" disabled={loading}>
          {loading ? "Logging in…" : "Log in"}
        </button>
      </form>

      <p className="mt-8 text-sm text-muted dark:text-muted-dark">
        No account yet?{" "}
        <Link href="/signup" className="text-seal-500 hover:underline dark:text-seal-400">
          Register your organization
        </Link>
      </p>
    </main>
  );
}
