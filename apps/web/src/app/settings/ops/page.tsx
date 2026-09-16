"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// Phase 3, item 1 — the real internal operations console. Platform-
// admin-only (same gate as /settings/reconciliation-findings), same
// client-fetch-from-API pattern that page already uses. Every section
// renders data GET /api/ops-console actually queried live (Prisma +
// RPC), not a mockup.

interface OpsConsoleData {
  generatedAt: string;
  health: {
    db: { ok: boolean; latencyMs: number | null; error?: string };
    redis: { ok: boolean; latencyMs: number | null; error?: string };
    sepoliaRpc: { ok: boolean; blockNumber: string | null; error?: string };
    solanaRpc: { ok: boolean; slot: number | null; error?: string };
    workerProcess: { note: string; runbook: string | null };
  };
  balances: {
    evmAttestors: Array<{ address: string; balanceEth: string }>;
    solanaAttestor: { address: string; balanceSol: string } | null;
  };
  escrowTotalsByChain: Record<string, string>;
  inFlightSettlementCount: number;
  pendingSignatures: Array<{ decisionId: string; caseId: string; chain: string; collected: number; threshold: number | null; ageMs: number }>;
  dispatchQueue: Array<{ decisionId: string; caseId: string; chain: string | null; relayAttempts: number; relayError: string | null; status: string; nextRetryAt: string | null }>;
  settlementFunnel: Record<string, Record<string, number>>;
  canary: { latest: Record<string, unknown> | null; latestSuccessful: Record<string, unknown> | null; stale: boolean; runbook: string | null };
  findings: Array<{ id: string; type: string; severity: string; targetType: string; targetId: string; openedAt: string; alertedAt: string | null; acknowledgedAt: string | null; runbook: string | null }>;
}

function fmtAge(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function StatusDot({ ok }: { ok: boolean }) {
  return <span className={ok ? "text-status-settled" : "text-status-undetermined"}>{ok ? "● healthy" : "● down"}</span>;
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: "text-status-undetermined",
  warning: "text-status-adjudicating",
  info: "text-muted dark:text-muted-dark",
};

export default function OpsConsolePage() {
  const [data, setData] = useState<OpsConsoleData | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/ops-console");
    if (res.status === 401 || res.status === 403) {
      setForbidden(true);
      return;
    }
    if (!res.ok) {
      setError(`request failed: ${res.status}`);
      return;
    }
    setData(await res.json());
    setError(null);
  }

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  if (forbidden) {
    return <div className="p-6">You do not have access to the operations console (PLATFORM_ADMIN_EMAILS).</div>;
  }
  if (error) {
    return <div className="p-6 text-status-undetermined">{error}</div>;
  }
  if (!data) {
    return <div className="p-6">Loading...</div>;
  }

  return (
    <div className="p-6 space-y-8 max-w-6xl">
      <div>
        <h1 className="text-xl font-semibold">Operations Console</h1>
        <p className="text-sm text-muted dark:text-muted-dark">Generated {new Date(data.generatedAt).toLocaleString()}, auto-refreshes every 30s.</p>
      </div>

      <section>
        <h2 className="font-medium mb-2">Infrastructure health</h2>
        <table className="w-full text-sm border-collapse">
          <tbody>
            <tr className="border-b">
              <td className="py-1 pr-4">Database</td>
              <td><StatusDot ok={data.health.db.ok} /></td>
              <td className="text-muted dark:text-muted-dark">{data.health.db.latencyMs !== null ? `${data.health.db.latencyMs}ms` : data.health.db.error}</td>
            </tr>
            <tr className="border-b">
              <td className="py-1 pr-4">Redis</td>
              <td><StatusDot ok={data.health.redis.ok} /></td>
              <td className="text-muted dark:text-muted-dark">{data.health.redis.latencyMs !== null ? `${data.health.redis.latencyMs}ms` : data.health.redis.error}</td>
            </tr>
            <tr className="border-b">
              <td className="py-1 pr-4">Sepolia RPC</td>
              <td><StatusDot ok={data.health.sepoliaRpc.ok} /></td>
              <td className="text-muted dark:text-muted-dark">{data.health.sepoliaRpc.ok ? `block ${data.health.sepoliaRpc.blockNumber}` : data.health.sepoliaRpc.error}</td>
            </tr>
            <tr className="border-b">
              <td className="py-1 pr-4">Solana testnet RPC</td>
              <td><StatusDot ok={data.health.solanaRpc.ok} /></td>
              <td className="text-muted dark:text-muted-dark">{data.health.solanaRpc.ok ? `slot ${data.health.solanaRpc.slot}` : data.health.solanaRpc.error}</td>
            </tr>
            <tr>
              <td className="py-1 pr-4">Worker process</td>
              <td colSpan={2} className="text-xs text-muted dark:text-muted-dark">
                {data.health.workerProcess.note}{" "}
                {data.health.workerProcess.runbook && (
                  <Link href={data.health.workerProcess.runbook} className="underline">runbook</Link>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-medium mb-2">Attestor balances</h2>
        <table className="w-full text-sm border-collapse">
          <tbody>
            {data.balances.evmAttestors.map((a) => (
              <tr key={a.address} className="border-b">
                <td className="py-1 pr-4 font-mono text-xs">{a.address}</td>
                <td>{a.balanceEth} ETH</td>
              </tr>
            ))}
            {data.balances.solanaAttestor && (
              <tr>
                <td className="py-1 pr-4 font-mono text-xs">{data.balances.solanaAttestor.address}</td>
                <td>{data.balances.solanaAttestor.balanceSol} SOL</td>
              </tr>
            )}
            {data.balances.evmAttestors.length === 0 && !data.balances.solanaAttestor && (
              <tr><td className="text-muted dark:text-muted-dark">This process holds no attestor keys.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-medium mb-2">Escrow totals in flight</h2>
        <p className="text-sm">{data.inFlightSettlementCount} unsettled CaseSettlement(s)</p>
        <table className="text-sm border-collapse">
          <tbody>
            {Object.entries(data.escrowTotalsByChain).map(([chain, atto]) => (
              <tr key={chain}><td className="pr-4">{chain}</td><td>{atto} atto</td></tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-medium mb-2">Settlement funnel (latest signer-lifecycle state per decision)</h2>
        <table className="text-sm border-collapse">
          <tbody>
            {Object.entries(data.settlementFunnel).map(([chain, states]) => (
              <tr key={chain}>
                <td className="pr-4 font-medium">{chain}</td>
                <td>{Object.entries(states).map(([s, n]) => `${s}: ${n}`).join("  •  ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-medium mb-2">Pending signatures ({data.pendingSignatures.length})</h2>
        <table className="w-full text-sm border-collapse">
          <thead><tr className="text-left border-b"><th>Decision</th><th>Chain</th><th>Collected / threshold</th><th>Age</th></tr></thead>
          <tbody>
            {data.pendingSignatures.map((p) => (
              <tr key={p.decisionId} className="border-b">
                <td className="font-mono text-xs">{p.decisionId}</td>
                <td>{p.chain}</td>
                <td>{p.collected}{p.threshold !== null ? `/${p.threshold}` : ""}</td>
                <td className={p.ageMs > 24 * 3600_000 ? "text-status-undetermined" : ""}>{fmtAge(p.ageMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-medium mb-2">Decisions awaiting dispatch ({data.dispatchQueue.length})</h2>
        <table className="w-full text-sm border-collapse">
          <thead><tr className="text-left border-b"><th>Decision</th><th>Chain</th><th>Attempts</th><th>Status</th><th>Next retry</th><th>Last error</th></tr></thead>
          <tbody>
            {data.dispatchQueue.map((d) => (
              <tr key={d.decisionId} className="border-b">
                <td className="font-mono text-xs">{d.decisionId}</td>
                <td>{d.chain}</td>
                <td>{d.relayAttempts}</td>
                <td>{d.status}</td>
                <td>{d.nextRetryAt ? new Date(d.nextRetryAt).toLocaleTimeString() : "in flight"}</td>
                <td className="text-xs text-muted dark:text-muted-dark">{d.relayError ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="font-medium mb-2">Testnet canary</h2>
        {data.canary.stale && (
          <p className="text-status-undetermined text-sm">
            No successful canary run recently.{" "}
            {data.canary.runbook && <Link href={data.canary.runbook} className="underline">runbook</Link>}
          </p>
        )}
        <pre className="text-xs bg-black/5 dark:bg-white/5 p-2 rounded overflow-auto">{JSON.stringify(data.canary.latestSuccessful ?? "none recorded", null, 2)}</pre>
      </section>

      <section>
        <h2 className="font-medium mb-2">Open findings ({data.findings.length}): <Link href="/settings/reconciliation-findings" className="underline">full list</Link></h2>
        <table className="w-full text-sm border-collapse">
          <thead><tr className="text-left border-b"><th>Type</th><th>Severity</th><th>Target</th><th>Opened</th><th>Runbook</th></tr></thead>
          <tbody>
            {data.findings.map((f) => (
              <tr key={f.id} className="border-b">
                <td>{f.type}</td>
                <td className={SEVERITY_COLOR[f.severity] ?? ""}>{f.severity}</td>
                <td className="font-mono text-xs">{f.targetType}:{f.targetId}</td>
                <td>{new Date(f.openedAt).toLocaleString()}</td>
                <td>{f.runbook ? <Link href={f.runbook} className="underline">resolve</Link> : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
