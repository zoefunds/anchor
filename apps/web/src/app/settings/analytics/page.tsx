"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface AnalyticsResult {
  generatedAt: string;
  disputeCount: number;
  disputeRatePerDay: number;
  avgResolutionTimeHours: number | null;
  appealRate: number;
  reversalRate: number;
  outcomeDistribution: Record<string, number>;
  settlementFailureRate: number;
  avgSettlementDelayHours: number | null;
  evidenceCompletionRate: number;
  settlementRetryRate: number;
  avgRelayAttempts: number | null;
  byPolicy: Record<string, { count: number; avgResolutionTimeHours: number | null }>;
  byAsset: Record<string, { count: number; settlementFailureRate: number }>;
  byIntegration: Record<string, { count: number; settlementFailureRate: number; settlementRetryRate: number }>;
}

const WINDOWS = [30, 90, 180] as const;

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`;
}

function hours(n: number | null) {
  return n === null ? "—" : `${n.toFixed(1)}h`;
}

export default function AnalyticsPage() {
  const [sinceDays, setSinceDays] = useState<number>(90);
  const [data, setData] = useState<AnalyticsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch(`/api/analytics?sinceDays=${sinceDays}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "failed to load analytics");
      return;
    }
    setError(null);
    setData(await res.json());
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinceDays]);

  return (
    <main className="mx-auto max-w-3xl px-8 py-16">
      <div className="flex items-center justify-between">
        <Link
          href="/cases"
          className="inline-flex items-center gap-1 font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400"
        >
          ← Docket
        </Link>
        <Link href="/settings/usage" className="font-mono text-xs text-muted hover:text-seal-500 dark:text-muted-dark dark:hover:text-seal-400">
          Usage →
        </Link>
      </div>

      <header className="mt-8 border-b border-line pb-8 dark:border-line-dark">
        <p className="kicker text-seal-500 dark:text-seal-400">Insight</p>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-950 dark:text-ink">Analytics</h1>
        <p className="mt-2 max-w-lg text-sm text-muted dark:text-muted-dark">
          Dispute volume, resolution time, appeal/reversal and settlement-failure rates for your
          organization, computed live from case history.
        </p>
        <div className="mt-4 flex gap-4 font-mono text-xs">
          {WINDOWS.map((w) => (
            <button key={w} className={w === sinceDays ? "text-seal-500 dark:text-seal-400" : "text-muted dark:text-muted-dark"} onClick={() => setSinceDays(w)}>
              last {w}d
            </button>
          ))}
        </div>
      </header>

      {error && <p className="mt-6 text-sm text-status-undetermined">{error}</p>}

      {data && (
        <>
          <section className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label="Disputes" value={String(data.disputeCount)} />
            <Stat label="Per day" value={data.disputeRatePerDay.toFixed(2)} />
            <Stat label="Avg resolution" value={hours(data.avgResolutionTimeHours)} />
            <Stat label="Appeal rate" value={pct(data.appealRate)} />
            <Stat label="Reversal rate" value={pct(data.reversalRate)} />
            <Stat label="Settlement failure" value={pct(data.settlementFailureRate)} />
            <Stat label="Avg settlement delay" value={hours(data.avgSettlementDelayHours)} />
            <Stat label="Evidence completion" value={pct(data.evidenceCompletionRate)} />
            <Stat label="Settlement retry rate" value={pct(data.settlementRetryRate)} />
          </section>

          <section className="mt-12">
            <p className="kicker mb-4">Outcome distribution</p>
            <div className="dossier">
              {Object.keys(data.outcomeDistribution).length === 0 && (
                <p className="text-sm text-muted dark:text-muted-dark">No decided cases in this window.</p>
              )}
              <table className="w-full text-sm">
                <tbody>
                  {Object.entries(data.outcomeDistribution).map(([outcome, count]) => (
                    <tr key={outcome} className="border-b border-line last:border-0 dark:border-line-dark">
                      <td className="py-2 font-mono text-xs">{outcome.replace(/_/g, " ")}</td>
                      <td className="py-2 text-right font-mono text-xs text-muted dark:text-muted-dark">{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-10">
            <p className="kicker mb-4">By policy</p>
            <div className="dossier">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left font-mono text-[11px] uppercase text-muted dark:border-line-dark dark:text-muted-dark">
                    <th className="py-2 font-normal">Policy</th>
                    <th className="py-2 text-right font-normal">Cases</th>
                    <th className="py-2 text-right font-normal">Avg resolution</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.byPolicy).map(([policyId, v]) => (
                    <tr key={policyId} className="border-b border-line last:border-0 dark:border-line-dark">
                      <td className="py-2 font-mono text-xs">{policyId}</td>
                      <td className="py-2 text-right font-mono text-xs text-muted dark:text-muted-dark">{v.count}</td>
                      <td className="py-2 text-right font-mono text-xs text-muted dark:text-muted-dark">{hours(v.avgResolutionTimeHours)}</td>
                    </tr>
                  ))}
                  {Object.keys(data.byPolicy).length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-4 text-center text-sm text-muted dark:text-muted-dark">
                        No cases in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-10">
            <p className="kicker mb-4">By asset</p>
            <div className="dossier">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left font-mono text-[11px] uppercase text-muted dark:border-line-dark dark:text-muted-dark">
                    <th className="py-2 font-normal">Asset</th>
                    <th className="py-2 text-right font-normal">Cases</th>
                    <th className="py-2 text-right font-normal">Settlement failure</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.byAsset).map(([asset, v]) => (
                    <tr key={asset} className="border-b border-line last:border-0 dark:border-line-dark">
                      <td className="py-2 font-mono text-xs">{asset}</td>
                      <td className="py-2 text-right font-mono text-xs text-muted dark:text-muted-dark">{v.count}</td>
                      <td className="py-2 text-right font-mono text-xs text-muted dark:text-muted-dark">{pct(v.settlementFailureRate)}</td>
                    </tr>
                  ))}
                  {Object.keys(data.byAsset).length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-4 text-center text-sm text-muted dark:text-muted-dark">
                        No settled cases in this window.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <p className="mt-8 font-mono text-[11px] text-muted dark:text-muted-dark">
            Generated {new Date(data.generatedAt).toLocaleString()}
          </p>
        </>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="dossier">
      <p className="field-label">{label}</p>
      <p className="mt-1 font-display text-2xl font-semibold text-ink-950 dark:text-ink">{value}</p>
    </div>
  );
}
