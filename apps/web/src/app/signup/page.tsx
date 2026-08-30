"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function SignupPage() {
  const router = useRouter();
  const [organizationName, setOrganizationName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationName, email, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "signup failed");
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
      <p className="kicker mt-6 text-seal-500 dark:text-seal-400">Register organization</p>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
        Create an account
      </h1>

      <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-6">
        <label className="flex flex-col gap-2">
          <span className="field-label">Organization name</span>
          <input
            className="field-input"
            value={organizationName}
            onChange={(e) => setOrganizationName(e.target.value)}
            required
          />
        </label>
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
          <span className="field-label">Password</span>
          <input
            className="field-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
        </label>

        {error && <p className="text-sm text-status-undetermined">{error}</p>}

        <button className="btn-primary mt-2" type="submit" disabled={loading}>
          {loading ? "Creating…" : "Create account"}
        </button>
      </form>

      <p className="mt-8 text-sm text-muted dark:text-muted-dark">
        Already have an account?{" "}
        <Link href="/login" className="text-seal-500 hover:underline dark:text-seal-400">
          Log in
        </Link>
      </p>
    </main>
  );
}
