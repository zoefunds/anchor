"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
  evidence?: Record<string, unknown>;
}

interface ReliabilityObservation {
  id: string;
  capturedAt: string;
  checks: CheckResult[];
  state: "HEALTHY" | "DEGRADED" | "DELIVERY_BLOCKED" | "UNKNOWN";
  passCount: number;
  warnCount: number;
  failCount: number;
  maxCheckpointLagLeaves: number | null;
  scriptCrashed: boolean;
  crashDetail: string | null;
}

const STATE_COLOR: Record<ReliabilityObservation["state"], string> = {
  HEALTHY: "text-seal-500 dark:text-seal-400",
  DEGRADED: "text-muted dark:text-muted-dark",
  DELIVERY_BLOCKED: "text-status-undetermined",
  UNKNOWN: "text-status-undetermined",
};

// Re-audit response (Phase 1, item 3) — real-time view of what
// lib/reliability-monitor.ts's periodic sweep has been recording,
// every 15 minutes, since it was wired in. This is the durable record
// a real 30-day reliability window needs — a passing (or failing) run
// today doesn't prove anything about the 29 days before it, which is
// exactly why this accumulates rather than only showing "now."
export default function ReliabilityPage() {
  const [observations, setObservations] = useState<ReliabilityObservation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/reliability-observations");
        if (res.status === 401 || res.status === 403) {
          setForbidden(true);
          return;
        }
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "failed to load reliability observations");
        setObservations(body);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  if (forbidden) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="text-sm text-status-undetermined">
          This is a platform-wide operator page, not an organization setting — your account isn't on the
          platform-admin allowlist.
        </p>
        <Link href="/cases" className="mt-4 inline-block text-sm text-seal-500 hover:underline dark:text-seal-400">
          ← Docket
        </Link>
      </main>
    );
  }

  const first = observations?.[observations.length - 1];
  const windowStart = first ? new Date(first.capturedAt) : null;
  const daysObserved = windowStart ? Math.floor((Date.now() - windowStart.getTime()) / (24 * 60 * 60 * 1000)) : 0;
  const failingCount = observations?.filter((o) => o.failCount > 0 || o.scriptCrashed).length ?? 0;

  return (
    <main className="mx-auto max-w-3xl px-8 py-16">
      <div className="flex items-center justify-between">
        <Link
          href="/cases"
          className="inline-flex items-center gap-1 font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
        >
          ← Docket
        </Link>
        <Link href="/settings/cutover-readiness" className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400">
          Cutover readiness →
        </Link>
      </div>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-seal-500 dark:text-seal-400">Re-audit Phase 1</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">Reliability observations</h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          A durable, queryable record — checkpoint currency, DecisionRelay/ISM wiring, validator
          independence — captured every 15 minutes. This is the evidence a real 30-day reliability window
          needs; it does not by itself satisfy that window, and does not authorize lifting{" "}
          <code className="font-mono">SETTLEMENT_PAUSED</code>.
        </p>
      </header>

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      {observations && (
        <section className="mt-10">
          <div className="dossier">
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="field-label">Observations</p>
                <p className="mt-1 font-mono text-2xl text-ink-950 dark:text-ink">{observations.length}</p>
              </div>
              <div>
                <p className="field-label">Days observed</p>
                <p className="mt-1 font-mono text-2xl text-ink-950 dark:text-ink">{daysObserved} / 30</p>
              </div>
              <div>
                <p className="field-label">Ticks with a failure</p>
                <p className={`mt-1 font-mono text-2xl ${failingCount > 0 ? "text-status-undetermined" : "text-seal-500 dark:text-seal-400"}`}>
                  {failingCount}
                </p>
              </div>
            </div>
            {observations.length === 0 && (
              <p className="mt-6 text-sm text-muted dark:text-muted-dark">
                No observations recorded yet — the sweep runs every 15 minutes once the worker is deployed
                with this change.
              </p>
            )}
          </div>

          <div className="mt-8 border-t border-line pt-6 dark:border-line-dark">
            <p className="field-label mb-4">History (most recent first)</p>
            <div className="flex flex-col gap-2">
              {observations.map((o) => {
                return (
                  <div key={o.id} className="border-b border-line pb-2 dark:border-line-dark">
                    <button
                      className="flex w-full items-center justify-between text-left"
                      onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                    >
                      <span className="font-mono text-xs text-muted dark:text-muted-dark">{new Date(o.capturedAt).toLocaleString()}</span>
                      <span className={`font-mono text-xs ${STATE_COLOR[o.state] ?? "text-muted dark:text-muted-dark"}`}>
                        {o.state} · {o.passCount} pass · {o.warnCount} warn · {o.failCount} fail
                        {o.maxCheckpointLagLeaves !== null && ` · lag ${o.maxCheckpointLagLeaves}`}
                      </span>
                    </button>
                    {expanded === o.id && (
                      <div className="mt-2 flex flex-col gap-1 pl-2">
                        {o.crashDetail && <p className="font-mono text-xs text-status-undetermined">{o.crashDetail}</p>}
                        {o.checks.map((c, i) => (
                          <p
                            key={i}
                            className={`break-all font-mono text-xs ${
                              c.status === "fail" ? "text-status-undetermined" : c.status === "warn" ? "text-muted dark:text-muted-dark" : "text-seal-500 dark:text-seal-400"
                            }`}
                          >
                            [{c.status}] {c.name}: {c.detail}
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
