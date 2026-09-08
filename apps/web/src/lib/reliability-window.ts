import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { checkDb, checkRedis, checkSepoliaRpc, checkSolanaRpc } from "@/lib/system-health";

// TRACK 1, item 1 — see docs/reliability-observation-window.md for the
// full written pass/fail and window-extension/reset rule this module
// implements. Every threshold below is named after, and must match,
// that document; if they ever disagree, the doc is authoritative and
// this file has a bug.

export const OBSERVATION_INTERVAL_MS = 15 * 60 * 1000;
const MISSED_OBSERVATION_GAP_MS = 20 * 60 * 1000;
const CANARY_STALE_MS = 2 * 60 * 60 * 1000;
const RECONCILIATION_GRACE_MS = 4 * 60 * 60 * 1000;
const UNACKNOWLEDGED_CRITICAL_MS = 60 * 60 * 1000;
const STALE_SIGNING_MS = 30 * 60 * 1000;
const QUORUM_LOSS_GAP_RESET_MS = 4 * 60 * 60 * 1000;

export type ComponentState = "pass" | "fail" | "unknown";

export interface ComponentSnapshot {
  db: ComponentState;
  redis: ComponentState;
  genlayer: ComponentState;
  evmRpc: ComponentState;
  solanaRpc: ComponentState;
  signerQuorum: ComponentState;
  relayerWorker: ComponentState;
  canary: ComponentState;
  reconciliation: ComponentState;
  detail: Record<string, unknown>;
}

export interface ObservationResult {
  components: ComponentSnapshot;
  status: "PASS" | "FAIL";
  failReasons: string[];
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 over canonical JSON — an honest, low-tech "signed" observation, same precedent as manifest-signature.ts. Not real PKI; see that module's own header and this track's report for the explicit scope statement. */
export function computeObservationHash(row: { capturedAt: Date; components: unknown; status: string; failReasons: string[]; notes: string | null; remediation: string | null }): string {
  return createHash("sha256")
    .update(canonicalize({ capturedAt: row.capturedAt.toISOString(), components: row.components, status: row.status, failReasons: row.failReasons, notes: row.notes, remediation: row.remediation }))
    .digest("hex");
}

async function checkGenlayer(): Promise<ComponentState> {
  const url = process.env.GENLAYER_RPC_URL;
  if (!url) return "unknown";
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
    return res.ok ? "pass" : "fail";
  } catch {
    return "fail";
  }
}

async function checkSignerQuorum(): Promise<{ state: ComponentState; detail: unknown }> {
  const chains = ["sepolia", "solanatestnet"];
  const perChain: Record<string, unknown> = {};
  let anyLoss = false;
  for (const chain of chains) {
    const latest = await prisma.signerLifecycleEvent.findFirst({ where: { chain }, orderBy: { createdAt: "desc" } });
    if (!latest) {
      perChain[chain] = { state: "unknown", reason: "no lifecycle events recorded yet" };
      continue;
    }
    const stuckSigning = latest.state === "SIGNING" && Date.now() - latest.createdAt.getTime() > STALE_SIGNING_MS;
    const lost = latest.state === "FAILED" || latest.state === "ESCALATED" || stuckSigning;
    if (lost) anyLoss = true;
    perChain[chain] = { state: latest.state, createdAt: latest.createdAt.toISOString(), lost };
  }
  return { state: anyLoss ? "fail" : "pass", detail: perChain };
}

async function checkCanaryAndRelayer(): Promise<{ canary: ComponentState; relayerWorker: ComponentState; detail: unknown }> {
  const latest = await prisma.canaryRun.findFirst({ orderBy: { createdAt: "desc" } });
  if (!latest) return { canary: "unknown", relayerWorker: "unknown", detail: { reason: "no canary runs recorded yet" } };
  const fresh = Date.now() - latest.createdAt.getTime() < CANARY_STALE_MS;
  return {
    canary: latest.outcome === "settled" ? "pass" : "fail",
    relayerWorker: fresh ? "pass" : "fail",
    detail: { outcome: latest.outcome, createdAt: latest.createdAt.toISOString(), freshWithinStaleWindow: fresh },
  };
}

async function checkReconciliation(): Promise<{ state: ComponentState; detail: unknown }> {
  const open = await prisma.reconciliationFinding.findMany({ where: { resolvedAt: null } });
  const now = Date.now();
  const pastGrace = open.filter((f) => now - f.openedAt.getTime() > RECONCILIATION_GRACE_MS);
  const unacknowledgedCritical = open.filter((f) => f.alertedAt && !f.acknowledgedAt && now - f.alertedAt.getTime() > UNACKNOWLEDGED_CRITICAL_MS);
  const fail = pastGrace.length > 0 || unacknowledgedCritical.length > 0;
  return {
    state: fail ? "fail" : "pass",
    detail: {
      openCount: open.length,
      pastGraceCount: pastGrace.length,
      unacknowledgedCriticalCount: unacknowledgedCritical.length,
      pastGraceIds: pastGrace.map((f) => f.id),
      unacknowledgedCriticalIds: unacknowledgedCritical.map((f) => f.id),
    },
  };
}

export async function computeObservation(): Promise<ObservationResult> {
  const [db, redis, evmRpc, solanaRpc, genlayer, signerQuorum, canaryRelayer, reconciliation] = await Promise.all([
    checkDb(),
    checkRedis(),
    checkSepoliaRpc(),
    checkSolanaRpc(),
    checkGenlayer(),
    checkSignerQuorum(),
    checkCanaryAndRelayer(),
    checkReconciliation(),
  ]);

  const components: ComponentSnapshot = {
    db: db.ok ? "pass" : "fail",
    redis: redis.ok ? "pass" : "fail",
    genlayer,
    evmRpc: evmRpc.ok ? "pass" : "fail",
    solanaRpc: solanaRpc.ok ? "pass" : "fail",
    signerQuorum: signerQuorum.state,
    relayerWorker: canaryRelayer.relayerWorker,
    canary: canaryRelayer.canary,
    reconciliation: reconciliation.state,
    detail: {
      db: db.error,
      redis: redis.error,
      evmRpc: evmRpc.error,
      solanaRpc: solanaRpc.error,
      signerQuorum: signerQuorum.detail,
      canary: canaryRelayer.detail,
      reconciliation: reconciliation.detail,
    },
  };

  const failReasons: string[] = [];
  if (components.db === "fail") failReasons.push("db_unreachable");
  if (components.redis === "fail") failReasons.push("redis_unreachable");
  if (components.genlayer === "fail") failReasons.push("genlayer_unreachable");
  if (components.evmRpc === "fail") failReasons.push("evm_rpc_unreachable");
  if (components.solanaRpc === "fail") failReasons.push("solana_rpc_unreachable");
  if (components.signerQuorum === "fail") failReasons.push("signer_quorum_loss");
  if (components.relayerWorker === "fail") failReasons.push("relayer_worker_stale_or_down");
  if (components.canary === "fail") failReasons.push("canary_failed");
  if (components.reconciliation === "fail") failReasons.push("unresolved_reconciliation_finding_or_unacknowledged_critical");

  return { components, status: failReasons.length > 0 ? "FAIL" : "PASS", failReasons };
}

export interface WindowFailTick {
  capturedAt: string;
  reasons: string[];
  resetsWindow: boolean;
  synthetic: boolean;
}

export interface WindowState {
  windowStartedAt: string | null;
  dayOfWindow: number;
  status: "PASS" | "FAIL" | "EXTENDED" | "NOT_STARTED";
  targetDays: number;
  failTicks: WindowFailTick[];
  totalObservations: number;
  lastObservationAt: string | null;
}

function resetsWindow(reasons: string[], gapMs: number | null): boolean {
  if (reasons.includes("signer_quorum_loss")) return true;
  if (gapMs !== null && gapMs > QUORUM_LOSS_GAP_RESET_MS) return true;
  return false;
}

/**
 * Walks all observations in chronological order applying
 * docs/reliability-observation-window.md's extension/reset rule, and
 * returns the resulting current window state. A gap between two real
 * rows longer than MISSED_OBSERVATION_GAP_MS is treated as one
 * synthetic "missed observation" FAIL tick, exactly as prescribed —
 * never silently skipped.
 */
export function computeWindowState(
  observations: Array<{ capturedAt: Date; status: string; failReasons: string[] }>,
  targetDays = 30
): WindowState {
  if (observations.length === 0) {
    return { windowStartedAt: null, dayOfWindow: 0, status: "NOT_STARTED", targetDays, failTicks: [], totalObservations: 0, lastObservationAt: null };
  }

  const sorted = [...observations].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  let windowStart = sorted[0].capturedAt;
  let extraDays = 0;
  const failTicks: WindowFailTick[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    if (i > 0) {
      const gapMs = row.capturedAt.getTime() - sorted[i - 1].capturedAt.getTime();
      if (gapMs > MISSED_OBSERVATION_GAP_MS) {
        const reset = resetsWindow(["missed_observation"], gapMs);
        failTicks.push({ capturedAt: sorted[i - 1].capturedAt.toISOString(), reasons: ["missed_observation"], resetsWindow: reset, synthetic: true });
        if (reset) {
          windowStart = row.capturedAt;
          extraDays = 0;
        } else {
          extraDays += 1;
        }
      }
    }
    if (row.status === "FAIL") {
      const reset = resetsWindow(row.failReasons, null);
      failTicks.push({ capturedAt: row.capturedAt.toISOString(), reasons: row.failReasons, resetsWindow: reset, synthetic: false });
      if (reset) {
        windowStart = row.capturedAt;
        extraDays = 0;
      } else {
        extraDays += 1;
      }
    }
  }

  const last = sorted[sorted.length - 1];
  const trailingGapMs = Date.now() - last.capturedAt.getTime();
  if (trailingGapMs > MISSED_OBSERVATION_GAP_MS) {
    const reset = resetsWindow(["missed_observation"], trailingGapMs);
    failTicks.push({ capturedAt: last.capturedAt.toISOString(), reasons: ["missed_observation"], resetsWindow: reset, synthetic: true });
    if (reset) {
      windowStart = new Date();
      extraDays = 0;
    } else {
      extraDays += 1;
    }
  }

  const elapsedDays = (Date.now() - windowStart.getTime()) / (24 * 60 * 60 * 1000);
  const dayOfWindow = Math.min(targetDays, Math.floor(elapsedDays) + 1);
  const hasRecentReset = failTicks.some((t) => t.resetsWindow && new Date(t.capturedAt).getTime() >= windowStart.getTime());
  const hasAnyExtension = extraDays > 0;
  const status: WindowState["status"] = elapsedDays >= targetDays ? "PASS" : hasAnyExtension || hasRecentReset ? "EXTENDED" : "PASS";

  return {
    windowStartedAt: windowStart.toISOString(),
    dayOfWindow,
    status,
    targetDays,
    failTicks,
    totalObservations: sorted.length,
    lastObservationAt: last.capturedAt.toISOString(),
  };
}
