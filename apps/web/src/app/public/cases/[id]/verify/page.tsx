"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

interface VerificationStatus {
  status: "NOT_STARTED" | "IN_PROGRESS" | "APPROVED" | "DECLINED" | "IN_REVIEW" | "ABANDONED" | "EXPIRED";
  sessionId: string | null;
}

const STATUS_COPY: Record<VerificationStatus["status"], { label: string; detail: string }> = {
  NOT_STARTED: { label: "Not started", detail: "Verify your identity to strengthen this case's record." },
  IN_PROGRESS: { label: "In progress", detail: "Your verification is underway. This page updates automatically." },
  APPROVED: { label: "Approved", detail: "Your identity has been verified." },
  DECLINED: { label: "Declined", detail: "Verification was declined. Contact the organization running this case if you believe this is an error." },
  IN_REVIEW: { label: "In review", detail: "Your verification needs manual review. This can take a little longer." },
  ABANDONED: { label: "Abandoned", detail: "The verification session was not completed. You can start a new one below." },
  EXPIRED: { label: "Expired", detail: "The verification session expired. You can start a new one below." },
};

// /public/cases/:id/verify — a claimant/respondent starts (or checks
// on) a real Didit KYC session for themselves. Not yet required by any
// other part of the product (no route currently blocks on this status)
// — this is the party-facing entry point the audit asked for; making
// verification mandatory before a real payout is a separate, later
// decision.
export default function VerifyPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const token = searchParams.get("token");

  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  async function loadStatus() {
    const qs = token ? `?token=${encodeURIComponent(token)}` : "";
    const res = await fetch(`/api/public/cases/${id}/verification${qs}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? "could not load verification status");
    }
    setStatus(await res.json());
  }

  useEffect(() => {
    let authFailed = false;
    loadStatus().catch((err) => {
      authFailed = true;
      setError(err instanceof Error ? err.message : String(err));
    });
    // Poll every 5s while a session may be actively updating — cheap,
    // and the only realistic way this page reflects a webhook landing
    // in the background while the party is still looking at it (the
    // alternative, no polling at all, means "in progress" could sit
    // stale until a manual refresh). Stops once the initial load fails
    // auth — a real bug caught while testing this page live: an
    // invalid/expired token kept re-polling every 5s forever instead of
    // just showing the error once.
    const interval = setInterval(() => {
      if (authFailed) return;
      loadStatus().catch(() => {
        /* transient poll failure — next tick will retry */
      });
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, token]);

  async function handleStart() {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/cases/${id}/verification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "could not start verification");
      if (body.url) {
        window.location.href = body.url;
        return;
      }
      setStatus(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  if (error) {
    return (
      <main className="mx-auto max-w-lg px-8 py-16">
        <p className="text-sm text-status-undetermined">{error}</p>
      </main>
    );
  }

  if (!status) {
    return (
      <main className="mx-auto max-w-lg px-8 py-16">
        <p className="font-mono text-sm text-muted dark:text-muted-dark">Loading…</p>
      </main>
    );
  }

  const copy = STATUS_COPY[status.status];
  const canStart = status.status === "NOT_STARTED" || status.status === "ABANDONED" || status.status === "EXPIRED";

  return (
    <main className="mx-auto max-w-lg px-8 py-16">
      <p className="font-display text-lg font-semibold text-ink-950 dark:text-ink">Anchor</p>
      <p className="kicker mt-2 text-seal-500 dark:text-seal-400">Identity verification</p>

      <div className="dossier mt-6">
        <div className="flex items-baseline justify-between">
          <p className="font-display text-2xl font-semibold text-ink-950 dark:text-ink">{copy.label}</p>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted dark:text-muted-dark">{copy.detail}</p>

        {canStart && (
          <button className="btn-primary mt-6" onClick={handleStart} disabled={starting}>
            {starting ? "Starting…" : "Start verification"}
          </button>
        )}

        {status.status === "IN_PROGRESS" && (
          <p className="mt-6 font-mono text-xs text-muted dark:text-muted-dark">
            session: {status.sessionId}
          </p>
        )}
      </div>
    </main>
  );
}
