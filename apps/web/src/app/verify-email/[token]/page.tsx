"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

export default function VerifyEmailPage() {
  const params = useParams();
  const token = params.token as string;
  const [state, setState] = useState<"pending" | "ok" | "error">("pending");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/auth/verify-email/${token}`, { method: "POST" })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error ?? "verification failed");
        }
        setState("ok");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      });
  }, [token]);

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-8">
      <Link href="/" className="font-display text-lg font-semibold text-ink-950 dark:text-ink">
        Anchor
      </Link>
      <p className="kicker mt-6 text-seal-500 dark:text-seal-400">Account</p>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
        {state === "ok" ? "Email verified" : state === "error" ? "Verification failed" : "Verifying…"}
      </h1>

      {state === "error" && <p className="mt-4 text-sm text-status-undetermined">{error}</p>}
      {state === "ok" && (
        <p className="mt-4 text-sm text-muted dark:text-muted-dark">
          Your email is confirmed.{" "}
          <Link href="/cases" className="text-seal-500 hover:underline dark:text-seal-400">
            Go to your cases
          </Link>
        </p>
      )}
    </main>
  );
}
