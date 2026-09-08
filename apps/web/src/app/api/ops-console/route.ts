import { NextResponse } from "next/server";
import { createPublicClient, http, formatEther } from "viem";
import { sepolia } from "viem/chains";
import { Connection, PublicKey } from "@solana/web3.js";
import { prisma } from "@/lib/prisma";
import { requirePlatformAdmin } from "@/lib/auth";
import { FINDING_SEVERITY } from "@/lib/reconciliation";
import { loadEvmDeploymentManifest, loadSolanaDeploymentManifest } from "@/lib/deployment-manifest";
import { getAttestorAccounts } from "@/lib/hyperlane";
import { checkDb, checkRedis, checkSepoliaRpc, checkSolanaRpc } from "@/lib/system-health";

// Phase 3, item 1: the real operations console — every section below
// queries live Prisma data or makes a real RPC call, nothing here is
// mock/static data. Platform-admin-only, same gate as
// /api/reconciliation-findings (this surfaces the same class of
// cross-tenant operational data).
//
// RUNBOOK_LINKS is the literal mapping acceptance criterion 2 depends
// on ("every dashboard finding links to a practical resolution
// procedure") — one entry per distinct problem class this endpoint can
// report, pointing at a real file under docs/runbooks/.
const RUNBOOK_LINKS: Record<string, string> = {
  WORKER_DOWN: "/docs/runbooks/worker-crash.md",
  SIGNER_UNAVAILABLE: "/docs/runbooks/signer-failure.md",
  QUORUM_UNAVAILABLE: "/docs/runbooks/signer-failure.md",
  STALE_PENDING_SIGNATURE: "/docs/runbooks/signer-failure.md",
  RELAY_RETRIES_EXHAUSTED: "/docs/runbooks/stuck-escrow.md",
  LATE_HYPERLANE_DELIVERY: "/docs/runbooks/relayer-failure.md",
  VALIDATOR_LAG: "/docs/runbooks/validator-lag.md",
  RPC_UNREACHABLE: "/docs/runbooks/rpc-outage.md",
  DB_UNREACHABLE: "/docs/runbooks/worker-crash.md",
  REDIS_UNREACHABLE: "/docs/runbooks/worker-crash.md",
  ZERO_SETTLEMENT_TARGET: "/docs/runbooks/stuck-escrow.md",
  TARGET_INTEGRATION_MISMATCH: "/docs/runbooks/stuck-escrow.md",
  OVERDUE_DEPOSIT: "/docs/runbooks/stuck-escrow.md",
  DISPATCHED_BUT_DB_STALE: "/docs/runbooks/failed-settlement.md",
  AUDIT_ANCHOR_STALE: "/docs/runbooks/failed-settlement.md",
  ESCROW_VERSION_MISMATCH: "/docs/runbooks/testnet-redeploy.md",
  CANARY_SLA_BREACH: "/docs/runbooks/failed-settlement.md",
  GOVERNANCE_DRIFT: "/docs/runbooks/safe-governance-config-change.md",
  CANARY_STALE: "/docs/runbooks/failed-settlement.md",
};

const RELAY_CLAIM_TTL_MS = 5 * 60 * 1000; // mirrors adjudication-service.ts's own constant
const SETTLEMENT_RETRY_INTERVAL_MS = 10 * 60 * 1000; // mirrors worker.ts's own constant
const CANARY_STALE_MS = 2 * 60 * 60 * 1000; // no successful canary run in 2h is itself worth flagging

async function evmAttestorBalances(): Promise<Array<{ address: string; balanceEth: string }>> {
  let accounts: ReturnType<typeof getAttestorAccounts>;
  try {
    accounts = getAttestorAccounts();
  } catch {
    return []; // this process holds no EVM attestor keys — see startup-checks.ts's own tolerant posture
  }
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.HYPERLANE_RELAY_RPC_URL) });
  return Promise.all(
    accounts.map(async (a) => {
      try {
        const balance = await client.getBalance({ address: a.address });
        return { address: a.address, balanceEth: formatEther(balance) };
      } catch (err) {
        return { address: a.address, balanceEth: `error: ${err instanceof Error ? err.message : String(err)}` };
      }
    })
  );
}

async function solanaAttestorBalance(): Promise<{ address: string; balanceSol: string } | null> {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  const raw = process.env.SOLANA_ATTESTOR_PRIVATE_KEY;
  if (!rpcUrl || !raw) return null;
  try {
    const { Keypair } = await import("@solana/web3.js");
    const secretKey = Uint8Array.from(JSON.parse(raw));
    const pubkey = Keypair.fromSecretKey(secretKey).publicKey;
    const connection = new Connection(rpcUrl, "confirmed");
    const lamports = await connection.getBalance(pubkey);
    return { address: pubkey.toBase58(), balanceSol: (lamports / 1e9).toString() };
  } catch (err) {
    return { address: "(unavailable)", balanceSol: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function GET() {
  const member = await requirePlatformAdmin();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const [db, redis, sepoliaRpcRaw, solanaRpcRaw, evmBalances, solanaBalance] = await Promise.all([
    checkDb(),
    checkRedis(),
    checkSepoliaRpc(),
    checkSolanaRpc(),
    evmAttestorBalances(),
    solanaAttestorBalance(),
  ]);
  // ops-console's response shape predates the shared module's generic
  // RpcCheckResult<T> — remap field names here so this route's existing
  // consumers (settings/ops/page.tsx) don't need to change.
  const sepoliaRpc = { ok: sepoliaRpcRaw.ok, blockNumber: sepoliaRpcRaw.value, error: sepoliaRpcRaw.error };
  const solanaRpc = { ok: solanaRpcRaw.ok, slot: solanaRpcRaw.value, error: solanaRpcRaw.error };

  // Pending signatures + age: decisions whose co-signing workflow
  // started but haven't dispatched — the live version of
  // reconciliation.ts's checkStalePendingSignatures, computed here
  // directly so the console reflects current state, not just the last
  // sweep tick's findings.
  const pendingEvm = await prisma.decision.findMany({
    where: { pendingAttestationHash: { not: null }, relayTxHash: null },
    select: { id: true, caseId: true, createdAt: true, pendingAttestationSignatures: true },
    orderBy: { createdAt: "asc" },
  });
  const pendingSolana = await prisma.decision.findMany({
    where: { pendingSolanaAttestationMessage: { not: null }, relayTxHash: null },
    select: { id: true, caseId: true, createdAt: true, pendingSolanaAttestations: true },
    orderBy: { createdAt: "asc" },
  });

  let evmThreshold: number | null = null;
  let solanaThreshold: number | null = null;
  try {
    evmThreshold = Number(loadEvmDeploymentManifest().decisionRelay.attestorThreshold);
  } catch {
    // manifest unavailable — leave null, the UI shows "unknown" rather than a wrong number
  }
  try {
    solanaThreshold = loadSolanaDeploymentManifest().decisionRelay.attestors.threshold;
  } catch {
    // see above
  }

  const now = Date.now();
  const pendingSignatures = [
    ...pendingEvm.map((d) => ({
      decisionId: d.id,
      caseId: d.caseId,
      chain: "sepolia",
      collected: d.pendingAttestationSignatures.length,
      threshold: evmThreshold,
      ageMs: now - d.createdAt.getTime(),
    })),
    ...pendingSolana.map((d) => ({
      decisionId: d.id,
      caseId: d.caseId,
      chain: "solanatestnet",
      collected: Array.isArray(d.pendingSolanaAttestations) ? (d.pendingSolanaAttestations as unknown[]).length : 0,
      threshold: solanaThreshold,
      ageMs: now - d.createdAt.getTime(),
    })),
  ].sort((a, b) => b.ageMs - a.ageMs);

  // Decisions awaiting dispatch: relayTxHash null, not yet at
  // MAX_RELAY_ATTEMPTS, whose case has a real settlement target — the
  // same population retryFailedSettlements' sweep drives, surfaced here
  // for visibility rather than action. relayClaimedAt within
  // RELAY_CLAIM_TTL_MS means a dispatch attempt is in flight right now;
  // otherwise "next retry" is estimated off the fixed sweep cadence.
  const awaitingDispatch = await prisma.decision.findMany({
    where: { relayTxHash: null, case: { settlementContract: { not: null } } },
    select: { id: true, caseId: true, createdAt: true, relayAttempts: true, relayError: true, relayClaimedAt: true, case: { select: { settlementChain: true } } },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  const dispatchQueue = awaitingDispatch.map((d) => {
    const claimedRecently = d.relayClaimedAt && now - d.relayClaimedAt.getTime() < RELAY_CLAIM_TTL_MS;
    return {
      decisionId: d.id,
      caseId: d.caseId,
      chain: d.case.settlementChain,
      relayAttempts: d.relayAttempts,
      relayError: d.relayError,
      status: claimedRecently ? "dispatch_in_flight" : "queued",
      nextRetryAt: claimedRecently ? null : new Date(now + SETTLEMENT_RETRY_INTERVAL_MS).toISOString(),
    };
  });

  // Dispatch/delivery/settlement funnel — one row per chain, counted off
  // SignerLifecycleEvent's latest state per decision (append-only, so
  // "latest per decisionId" is the current lifecycle position).
  const lifecycleEvents = await prisma.signerLifecycleEvent.findMany({
    orderBy: { createdAt: "desc" },
    select: { decisionId: true, chain: true, state: true, createdAt: true },
  });
  const latestByDecision = new Map<string, (typeof lifecycleEvents)[number]>();
  for (const ev of lifecycleEvents) {
    if (!latestByDecision.has(ev.decisionId)) latestByDecision.set(ev.decisionId, ev);
  }
  const funnel: Record<string, Record<string, number>> = {};
  for (const ev of latestByDecision.values()) {
    funnel[ev.chain] ??= {};
    funnel[ev.chain][ev.state] = (funnel[ev.chain][ev.state] ?? 0) + 1;
  }

  // Escrow totals: sum of expectedAmountAtto across settlements not yet
  // SETTLED, grouped by chain — the real "how much value is currently
  // in-flight" figure, from CaseSettlement, not derived from a live
  // per-contract balance sweep (integrations can span many escrow
  // contracts).
  const inFlightSettlements = await prisma.caseSettlement.groupBy({
    by: ["escrowId"],
    where: { status: { in: ["PENDING_DEPOSIT", "DEPOSITED"] } },
    _count: true,
  });
  const settlementsWithIntegration = await prisma.caseSettlement.findMany({
    where: { status: { in: ["PENDING_DEPOSIT", "DEPOSITED"] } },
    select: { expectedAmountAtto: true, integration: { select: { chain: true } } },
  });
  const escrowTotalsByChain: Record<string, string> = {};
  for (const cs of settlementsWithIntegration) {
    const chain = cs.integration.chain;
    const prev = BigInt(escrowTotalsByChain[chain] ?? "0");
    escrowTotalsByChain[chain] = (prev + BigInt(cs.expectedAmountAtto)).toString();
  }

  const openFindings = await prisma.reconciliationFinding.findMany({
    where: { resolvedAt: null },
    orderBy: [{ openedAt: "desc" }],
    take: 100,
  });
  const findingsWithRunbooks = openFindings.map((f) => ({
    ...f,
    severity: FINDING_SEVERITY[f.type] ?? "warning",
    runbook: RUNBOOK_LINKS[f.type] ?? null,
  }));

  const latestCanary = await prisma.canaryRun.findFirst({ orderBy: { createdAt: "desc" } });
  const latestSuccessfulCanary = await prisma.canaryRun.findFirst({ where: { outcome: "settled" }, orderBy: { createdAt: "desc" } });
  const canaryStale = !latestSuccessfulCanary || now - latestSuccessfulCanary.createdAt.getTime() > CANARY_STALE_MS;

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    health: {
      db,
      redis,
      sepoliaRpc,
      solanaRpc,
      workerProcess: {
        note: "This API route runs in the Next.js request process, not the standalone worker — a healthy response here proves DB/Redis/RPC reachability, not that lib/worker.ts's process is itself alive. Cross-check SignerLifecycleEvent/ReconciliationFinding recency below, or the worker's own process supervisor (fly status / pm2), for that.",
        runbook: RUNBOOK_LINKS.WORKER_DOWN,
      },
    },
    balances: { evmAttestors: evmBalances, solanaAttestor: solanaBalance },
    escrowTotalsByChain,
    inFlightSettlementCount: inFlightSettlements.length,
    pendingSignatures,
    dispatchQueue,
    settlementFunnel: funnel,
    canary: {
      latest: latestCanary,
      latestSuccessful: latestSuccessfulCanary,
      stale: canaryStale,
      runbook: canaryStale ? RUNBOOK_LINKS.CANARY_STALE : null,
    },
    findings: findingsWithRunbooks,
    runbookLinks: RUNBOOK_LINKS,
  });
}
