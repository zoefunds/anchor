"use client";

import { useState } from "react";
import Link from "next/link";

interface CutoverReadinessReport {
  checkedAt: string;
  safeAddress: string | null;
  safeThreshold: number | null;
  integrations: {
    integrationId: string;
    chain: string;
    escrowContractAddress: string;
    escrowVersion: string;
    active: boolean;
    depositsEverMade: number;
    unsettledEscrowIds: string[];
    currentSettlementTargets: { decisionRelay: string; liveTarget: string; matchesIntegration: boolean }[];
  }[];
  totalUnsettledV1Deposits: number;
  ready: boolean;
  blockingReasons: string[];
}

// Item D UI — the same real checks scripts/cutover-readiness-check.sh
// performs (unsettled V1 deposits, Safe threshold, live settlementTarget
// vs. each integration), run on demand from the dashboard instead of
// CLI+SSH only. This page never authorizes a cutover by itself — see
// docs/v1-v2-escrow-cutover.md for the full checklist.
export default function CutoverReadinessPage() {
  const [report, setReport] = useState<CutoverReadinessReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  async function runCheck() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cutover-readiness");
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        return;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "readiness check failed");
      setReport(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  if (forbidden) {
    return (
      <main className="mx-auto max-w-3xl px-8 py-16">
        <p className="text-sm text-status-undetermined">Only your organization's owner can run the cutover readiness check.</p>
        <Link href="/cases" className="mt-4 inline-block text-sm text-seal-500 hover:underline dark:text-seal-400">
          ← Docket
        </Link>
      </main>
    );
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
        <Link href="/settings/members" className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400">
          Members →
        </Link>
      </div>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-seal-500 dark:text-seal-400">Item D</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">Cutover readiness</h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          Read-only. Scans every real on-chain deposit ever made against each registered escrow, and
          re-reads the live settlementTarget and Safe threshold. This does not authorize a cutover by
          itself — see <code className="font-mono">docs/v1-v2-escrow-cutover.md</code> for the full
          checklist.
        </p>
      </header>

      <button className="btn-primary mt-8" onClick={runCheck} disabled={loading}>
        {loading ? "Scanning on-chain state…" : "Run readiness check"}
      </button>

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      {report && (
        <section className="mt-10">
          <div className="dossier">
            <div className="flex items-baseline justify-between">
              <p className={`font-display text-2xl font-semibold ${report.ready ? "text-seal-500 dark:text-seal-400" : "text-status-undetermined"}`}>
                {report.ready ? "READY" : "NOT READY"}
              </p>
              <span className="font-mono text-[11px] text-muted dark:text-muted-dark">checked {new Date(report.checkedAt).toLocaleString()}</span>
            </div>

            <p className="mt-4 text-sm text-muted dark:text-muted-dark">
              Total unsettled V1 deposits: <span className="font-mono text-ink-950 dark:text-ink">{report.totalUnsettledV1Deposits}</span>
            </p>
            {report.safeAddress && (
              <p className="mt-1 text-sm text-muted dark:text-muted-dark">
                Safe threshold: <span className="font-mono text-ink-950 dark:text-ink">{report.safeThreshold ?? "unreadable"}</span> (expected 2)
              </p>
            )}

            {report.blockingReasons.length > 0 && (
              <div className="mt-6 border-t border-line pt-4 dark:border-line-dark">
                <p className="field-label mb-2">Blocking reasons</p>
                <ul className="flex flex-col gap-1">
                  {report.blockingReasons.map((reason, i) => (
                    <li key={i} className="font-mono text-xs text-status-undetermined">
                      {reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-6 border-t border-line pt-6 dark:border-line-dark">
              <p className="field-label mb-4">Integrations ({report.integrations.length})</p>
              {report.integrations.map((integration) => (
                <div key={integration.integrationId} className="mb-4 border-b border-line pb-4 dark:border-line-dark">
                  <p className="break-all font-mono text-sm text-ink-950 dark:text-ink">{integration.escrowContractAddress}</p>
                  <p className="mt-1 font-mono text-xs text-muted dark:text-muted-dark">
                    {integration.chain} · {integration.escrowVersion} · {integration.active ? "active" : "inactive"} · {integration.depositsEverMade} deposit(s) ever made
                  </p>
                  {integration.unsettledEscrowIds.length > 0 && (
                    <p className="mt-1 break-all font-mono text-xs text-status-undetermined">
                      unsettled: {integration.unsettledEscrowIds.join(", ")}
                    </p>
                  )}
                  {integration.currentSettlementTargets.map((t) => (
                    <p key={t.decisionRelay} className="mt-1 break-all font-mono text-xs text-muted dark:text-muted-dark">
                      {t.decisionRelay} → {t.liveTarget} {t.matchesIntegration ? "(matches)" : "*** MISMATCH ***"}
                    </p>
                  ))}
                </div>
              ))}
              {report.integrations.length === 0 && <p className="text-sm text-muted dark:text-muted-dark">No Sepolia settlement integrations registered.</p>}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
