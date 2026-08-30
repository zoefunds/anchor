"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

interface InviteInfo {
  email: string;
  organizationName: string;
}

export default function AcceptInvitePage() {
  const params = useParams();
  const token = params.token as string;
  const router = useRouter();

  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`/api/invites/${token}`)
      .then(async (res) => {
        if (!res.ok) {
          setNotFound(true);
          return;
        }
        setInvite(await res.json());
      })
      .catch(() => setNotFound(true));
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/invites/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to accept invite");
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
      <p className="kicker mt-6 text-seal-500 dark:text-seal-400">Organization invite</p>

      {notFound && (
        <>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
            Invite not found
          </h1>
          <p className="mt-4 text-sm text-muted dark:text-muted-dark">
            This invite link is invalid, expired, or has already been used.
          </p>
        </>
      )}

      {invite && (
        <>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
            Join {invite.organizationName}
          </h1>
          <p className="mt-2 text-sm text-muted dark:text-muted-dark">
            Setting up an account for <span className="font-mono">{invite.email}</span>
          </p>

          <form onSubmit={handleSubmit} className="mt-10 flex flex-col gap-6">
            <label className="flex flex-col gap-2">
              <span className="field-label">Password</span>
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
              {loading ? "Joining…" : "Join organization"}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
