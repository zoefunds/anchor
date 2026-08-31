"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { StatusStamp } from "@/components/StatusStamp";

interface PublicEvidence {
  id: string;
  type: string;
  storageRef: string;
  mimeType: string | null;
  createdAt: string;
}

interface PublicDecision {
  outcome: string;
  claimantShareBps: number | null;
  respondentShareBps: number | null;
  reasonCodes: string[];
  consensus: string;
  appealWindowClosesAt: string | null;
  createdAt: string;
}

interface PublicCase {
  id: string;
  status: string;
  claim: string;
  amount: string;
  currency: string;
  policyId: string;
  claimantRef: string;
  respondentRef: string;
  createdAt: string;
  evidence: PublicEvidence[];
  decisions: PublicDecision[];
}

export default function PublicCasePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const token = searchParams.get("token");
  const [kase, setKase] = useState<PublicCase | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      // If a raw token is in the URL, exchange it for a short-lived
      // HttpOnly session cookie immediately and strip it from the
      // address bar (history.replaceState — no navigation, no reload).
      // The token itself is a long-lived bearer secret; leaving it
      // sitting in the URL means it keeps accumulating in browser
      // history, referrer headers on any outbound link/image on this
      // page, and screenshots for as long as the tab stays open. After
      // this, the cookie (not the query string) is what authenticates
      // every request.
      if (token) {
        const exchangeRes = await fetch(`/api/public/cases/${id}/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (exchangeRes.ok) {
          window.history.replaceState(null, "", `/public/cases/${id}`);
        }
        // If the exchange failed, fall through to the plain fetch below
        // — it'll surface the same "invalid token" error from the case
        // route itself rather than duplicating that logic here.
      }

      const res = await fetch(`/api/public/cases/${id}${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "case not found");
      }
      setKase(await res.json());
    }

    // Runs even with no token in the URL — a session cookie from an
    // earlier visit to this same case may still be valid.
    load().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id, token]);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="text-sm text-status-undetermined">{error}</p>
      </main>
    );
  }

  if (!kase) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="font-mono text-sm text-muted dark:text-muted-dark">Loading…</p>
      </main>
    );
  }

  const latestDecision = kase.decisions[0];

  return (
    <main className="mx-auto max-w-3xl px-8 py-16">
      <p className="font-display text-lg font-semibold text-ink-950 dark:text-ink">Anchor</p>
      <p className="kicker mt-2 text-seal-500 dark:text-seal-400">Public case record</p>

      <header className="mt-4 border-b border-line pb-8 dark:border-line-dark">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-mono text-xs text-muted dark:text-muted-dark">{kase.id}</p>
          <StatusStamp status={kase.status} />
        </div>
        <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">
          {kase.claim}
        </h1>
        <p className="mt-2 text-sm text-muted dark:text-muted-dark">
          {kase.claimantRef} <span className="mx-1 text-line dark:text-line-dark">v.</span>{" "}
          {kase.respondentRef}
          <span className="mx-2 text-line dark:text-line-dark">·</span>
          <span className="font-mono tabular-nums">
            {kase.amount} {kase.currency}
          </span>
          <span className="mx-2 text-line dark:text-line-dark">·</span>
          <span className="font-mono text-xs">{kase.policyId}</span>
        </p>
      </header>

      {latestDecision && (
        <section className="mt-10">
          <p className="kicker mb-4 text-seal-500 dark:text-seal-400">Verdict</p>
          <div className="dossier">
            <div className="flex items-baseline justify-between">
              <p className="font-display text-2xl font-semibold text-ink-950 dark:text-ink">
                {latestDecision.outcome.replace(/_/g, " ")}
              </p>
              <span className="font-mono text-[11px] uppercase tracking-wide text-muted dark:text-muted-dark">
                consensus · {latestDecision.consensus}
              </span>
            </div>
            {latestDecision.claimantShareBps !== null && (
              <div className="mt-6 flex flex-col gap-5 sm:flex-row sm:gap-8">
                <ShareBar label="Claimant" bps={latestDecision.claimantShareBps} />
                <ShareBar label="Respondent" bps={latestDecision.respondentShareBps!} />
              </div>
            )}
            <p className="mt-6 border-t border-line pt-4 font-mono text-xs text-muted dark:border-line-dark dark:text-muted-dark">
              Grounds: {latestDecision.reasonCodes.join(" · ")}
            </p>
          </div>
        </section>
      )}

      <section className="mt-10">
        <p className="kicker mb-4">Exhibits ({kase.evidence.length})</p>
        <div className="border-t border-line dark:border-line-dark">
          {kase.evidence.map((e) => (
            <div key={e.id} className="flex flex-col gap-1.5 border-b border-line py-5 dark:border-line-dark">
              <p className="field-label">{e.type}</p>
              {e.mimeType?.startsWith("image/") ? (
                <a href={e.storageRef} target="_blank" rel="noreferrer">
                  <img
                    src={e.storageRef}
                    alt={e.type}
                    className="mt-1 max-h-64 max-w-full border border-line object-contain dark:border-line-dark"
                  />
                </a>
              ) : e.mimeType ? (
                <a href={e.storageRef} target="_blank" rel="noreferrer" className="text-sm text-seal-500 underline dark:text-seal-400">
                  {e.mimeType} file — open
                </a>
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{e.storageRef.slice(0, 400)}</p>
              )}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function ShareBar({ label, bps }: { label: string; bps: number }) {
  const pct = bps / 100;
  return (
    <div className="flex-1">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="field-label">{label}</span>
        <span className="font-mono text-sm tabular-nums text-ink-950 dark:text-ink">{pct.toFixed(2)}%</span>
      </div>
      <div className="h-1 overflow-hidden bg-line dark:bg-line-dark">
        <div className="h-full bg-seal-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
