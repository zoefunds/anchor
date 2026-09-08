"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface ReviewApproval {
  id: string;
  memberId: string;
  decision: "APPROVE" | "REJECT";
  reason: string | null;
  createdAt: string;
}

interface ReviewNote {
  id: string;
  memberId: string;
  note: string;
  createdAt: string;
}

interface ReviewCase {
  id: string;
  claim: string;
  amount: string;
  currency: string;
  status: string;
  claimantRef: string;
  respondentRef: string;
}

interface Review {
  id: string;
  caseId: string;
  trigger: "HIGH_VALUE" | "FRAUD_RISK" | "MANUAL";
  status: "PENDING" | "APPROVED" | "REJECTED";
  requiresDualApproval: boolean;
  createdAt: string;
  resolvedAt: string | null;
  case: ReviewCase;
  approvals: ReviewApproval[];
  notes: ReviewNote[];
}

const TRIGGER_LABEL: Record<string, string> = {
  HIGH_VALUE: "High value",
  FRAUD_RISK: "Fraud risk",
  MANUAL: "Manual",
};

export default function ReviewsQueuePage() {
  const [status, setStatus] = useState<"PENDING" | "APPROVED" | "REJECTED" | "all">("PENDING");
  const [reviews, setReviews] = useState<Review[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [reasonDrafts, setReasonDrafts] = useState<Record<string, string>>({});

  async function load() {
    const qs = status === "all" ? "" : `?status=${status}`;
    const res = await fetch(`/api/cases/reviews${qs}`);
    if (res.ok) setReviews(await res.json());
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function vote(review: Review, decision: "APPROVE" | "REJECT") {
    setBusyId(review.id);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${review.caseId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "vote", decision, reason: reasonDrafts[review.id] || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to record vote");
      setReasonDrafts((prev) => ({ ...prev, [review.id]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function addNote(review: Review) {
    const note = noteDrafts[review.id];
    if (!note || note.trim().length === 0) return;
    setBusyId(review.id);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${review.caseId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "note", note }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "failed to add note");
      setNoteDrafts((prev) => ({ ...prev, [review.id]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
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
        <Link href="/settings/policies" className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400">
          Policies →
        </Link>
      </div>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-seal-500 dark:text-seal-400">Escalation</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">Review queue</h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          Cases a policy's human-review triggers (high value, fraud risk) or a manual escalation have
          pulled out of automatic settlement. A review needs 2 independent approvals when
          dual-approval is required, or 1 otherwise — any single reject stops it immediately.
        </p>
        <div className="mt-4 flex gap-4 font-mono text-xs">
          {(["PENDING", "APPROVED", "REJECTED", "all"] as const).map((s) => (
            <button key={s} className={s === status ? "text-seal-500 dark:text-seal-400" : "text-muted dark:text-muted-dark"} onClick={() => setStatus(s)}>
              {s.toLowerCase()}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      <section className="mt-10">
        {reviews.length === 0 && (
          <p className="py-8 text-center text-sm text-muted dark:text-muted-dark">
            No {status === "all" ? "" : status.toLowerCase()} reviews.
          </p>
        )}
        {reviews.map((r) => {
          const approveCount = r.approvals.filter((a) => a.decision === "APPROVE").length;
          const required = r.requiresDualApproval ? 2 : 1;
          return (
            <div key={r.id} className="dossier mb-6">
              <div className="flex items-baseline justify-between">
                <p className="font-mono text-sm font-semibold text-ink-950 dark:text-ink">
                  [{TRIGGER_LABEL[r.trigger] ?? r.trigger}] {r.case.claim}
                </p>
                <span className="font-mono text-[11px] uppercase tracking-wide text-muted dark:text-muted-dark">{r.status}</span>
              </div>
              <p className="mt-1 font-mono text-xs text-muted dark:text-muted-dark">
                <Link href={`/cases/${r.caseId}`} className="hover:text-seal-500 dark:hover:text-seal-400">
                  {r.caseId}
                </Link>{" "}
                · {r.case.amount} {r.case.currency} · opened {new Date(r.createdAt).toLocaleString()}
              </p>
              <p className="mt-2 font-mono text-xs text-muted dark:text-muted-dark">
                Approvals {approveCount}/{required}
                {r.requiresDualApproval ? " (dual approval required)" : ""}
              </p>

              {r.notes.length > 0 && (
                <div className="mt-4 border-t border-line pt-3 dark:border-line-dark">
                  <p className="field-label mb-2">Notes</p>
                  <ul className="flex flex-col gap-2">
                    {r.notes.map((n) => (
                      <li key={n.id} className="text-sm">
                        <span className="font-mono text-xs text-muted dark:text-muted-dark">
                          {new Date(n.createdAt).toLocaleString()} · {n.memberId}
                        </span>
                        <p className="mt-0.5">{n.note}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {r.approvals.length > 0 && (
                <div className="mt-4 border-t border-line pt-3 dark:border-line-dark">
                  <p className="field-label mb-2">Votes</p>
                  <ul className="flex flex-col gap-1 font-mono text-xs text-muted dark:text-muted-dark">
                    {r.approvals.map((a) => (
                      <li key={a.id}>
                        {a.decision} · {a.memberId}
                        {a.reason ? ` — ${a.reason}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {r.status === "PENDING" && (
                <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4 dark:border-line-dark">
                  <textarea
                    className="field-input"
                    placeholder="Vote reason / reviewer note"
                    value={reasonDrafts[r.id] ?? noteDrafts[r.id] ?? ""}
                    onChange={(e) => {
                      setReasonDrafts((prev) => ({ ...prev, [r.id]: e.target.value }));
                      setNoteDrafts((prev) => ({ ...prev, [r.id]: e.target.value }));
                    }}
                    rows={2}
                  />
                  <div className="flex gap-3">
                    <button className="btn-primary" onClick={() => vote(r, "APPROVE")} disabled={busyId === r.id}>
                      Approve
                    </button>
                    <button className="btn-secondary" onClick={() => vote(r, "REJECT")} disabled={busyId === r.id}>
                      Reject
                    </button>
                    <button className="btn-secondary" onClick={() => addNote(r)} disabled={busyId === r.id}>
                      Add note
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </main>
  );
}
