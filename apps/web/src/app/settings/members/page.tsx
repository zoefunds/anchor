"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface InviteSummary {
  id: string;
  email: string;
  expiresAt: string;
  createdAt: string;
}

export default function MembersPage() {
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/invites");
    if (res.ok) setInvites(await res.json());
  }

  useEffect(() => {
    load();
  }, []);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviting(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to send invite");
      setNote(
        body.emailError
          ? `Invite created, but the email failed to send (${body.emailError}). Share this link directly: ${body.inviteUrl}`
          : `Invite sent to ${email}.`
      );
      setEmail("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInviting(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-8 py-16">
      <div className="flex items-center justify-between">
        <Link
          href="/cases"
          className="inline-flex items-center gap-1 font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
        >
          ← Docket
        </Link>
        <Link
          href="/settings/keys"
          className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
        >
          API keys →
        </Link>
      </div>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-seal-500 dark:text-seal-400">Organization</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
          Members
        </h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          Invite colleagues into your organization. Every member sees the same cases.
        </p>
      </header>

      {note && (
        <p className="mt-6 break-all border-l-2 border-status-active bg-status-active/5 py-2 pl-4 text-sm text-status-active">
          {note}
        </p>
      )}
      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      <section className="mt-10">
        <p className="kicker mb-4">Invite a member</p>
        <form onSubmit={handleInvite} className="flex items-end gap-4">
          <label className="flex flex-1 flex-col gap-2">
            <span className="field-label">Email</span>
            <input
              className="field-input"
              type="email"
              placeholder="teammate@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </label>
          <button className="btn-primary" type="submit" disabled={inviting}>
            {inviting ? "Sending…" : "Send invite"}
          </button>
        </form>
      </section>

      <section className="mt-12">
        <p className="kicker mb-4">Pending invites</p>
        <div className="border-t border-line dark:border-line-dark">
          {invites.length === 0 && (
            <p className="py-8 text-center text-sm text-muted dark:text-muted-dark">No pending invites.</p>
          )}
          {invites.map((i) => (
            <div key={i.id} className="flex items-center justify-between border-b border-line py-4 dark:border-line-dark">
              <p className="text-sm font-medium">{i.email}</p>
              <p className="font-mono text-xs text-muted dark:text-muted-dark">
                expires {new Date(i.expiresAt).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
