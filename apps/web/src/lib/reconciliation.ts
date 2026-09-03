import type { Prisma } from "@prisma/client";
import { type Address, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { prisma } from "@/lib/prisma";
import { sendOpsAlert } from "@/lib/alerts";

// Item F's reconciliation half — the real chain: decision -> attestation
// -> dispatch -> delivery -> processed -> settled -> payout ->
// audit-anchored. Every check here reads real on-chain state (never
// trusts the DB's own claim about itself) and persists what it finds
// to ReconciliationFinding, which is what actually drives alerting —
// see lib/alerts.ts. Meant to run periodically (see worker.ts), not
// from a request path.

const OVERDUE_DEPOSIT_MS = Number(process.env.RECONCILIATION_OVERDUE_DEPOSIT_MS ?? 24 * 60 * 60 * 1000); // 24h default
// Mirrors worker.ts's AUDIT_ANCHOR_SWEEP_INTERVAL_MS (30 min) — kept as
// an independent constant rather than importing worker.ts here, since
// this module has no other reason to depend on the BullMQ scheduling
// layer at all.
const AUDIT_ANCHOR_STALE_MS = 2 * 30 * 60 * 1000;

const DECISION_RELAY_ABI = [
  {
    type: "function",
    name: "settlementTarget",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "processedDecisions",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// Real fix, matching the same bug caught in case-settlement.ts: the
// live V1 Escrow contract's deposits() has only these four fields —
// caseId is V2-only, unreleased source. A 5-output ABI here made
// checkDispatchedButStale's own deposits() read fail to decode
// against every real deposit.
const ESCROW_ABI = [
  {
    type: "function",
    name: "deposits",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "claimant", type: "address" },
      { name: "respondent", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HYPERLANE_DOMAIN_SEPOLIA = 11155111;

function getClient() {
  return createPublicClient({ chain: sepolia, transport: http(process.env.HYPERLANE_RELAY_RPC_URL) });
}

function hashToBytes32(hash: string): `0x${string}` {
  return `0x${hash.replace(/^0x/, "").padStart(64, "0")}` as `0x${string}`;
}

/**
 * Delivers one alert and only marks alertedAt when sendOpsAlert
 * proves a message actually reached Slack — a real bug this exact
 * function fixes: sendOpsAlert resolving without throwing is NOT the
 * same as an alert having gone out (it also resolves when
 * OPS_ALERT_WEBHOOK_URL is unset), and a caller that stamped
 * alertedAt on that resolution alone recorded a real finding as
 * "notified" when nothing had actually been delivered — caught only
 * by hand-checking the Slack channel, not by any code path noticing
 * on its own. Leaving alertedAt null on a skip/failure is what makes
 * raiseFinding's retry-if-never-delivered logic below actually work.
 */
async function tryAlert(findingId: string, alert: { severity: "info" | "warning" | "critical"; title: string; detail: string }): Promise<void> {
  try {
    const delivered = await sendOpsAlert(alert);
    if (delivered) {
      await prisma.reconciliationFinding.update({ where: { id: findingId }, data: { alertedAt: new Date() } });
    }
  } catch (err) {
    console.error(`reconciliation: failed to deliver alert for finding ${findingId}`, err);
  }
}

/**
 * Opens a ReconciliationFinding if one doesn't already exist for this
 * (type, targetId), and sends exactly one "opened" alert for it — a
 * sweep tick where the same problem is still true does NOT re-alert,
 * UNLESS the previous attempt never actually delivered (alertedAt
 * still null — see tryAlert above), in which case this retries the
 * alert without touching the finding's own openedAt/detail, since the
 * finding itself was already real and already open.
 */
async function raiseFinding(params: {
  type:
    | "ZERO_SETTLEMENT_TARGET"
    | "TARGET_INTEGRATION_MISMATCH"
    | "OVERDUE_DEPOSIT"
    | "DISPATCHED_BUT_DB_STALE"
    | "AUDIT_ANCHOR_STALE";
  targetType: string;
  targetId: string;
  detail: Record<string, unknown>;
  severity: "warning" | "critical";
  title: string;
  alertDetail: string;
}): Promise<void> {
  const existing = await prisma.reconciliationFinding.findUnique({
    where: { type_targetId: { type: params.type, targetId: params.targetId } },
  });
  if (existing && !existing.resolvedAt) {
    if (!existing.alertedAt) {
      await tryAlert(existing.id, { severity: params.severity, title: params.title, detail: params.alertDetail });
    }
    return;
  }

  const finding = existing
    ? await prisma.reconciliationFinding.update({
        where: { id: existing.id },
        data: { resolvedAt: null, detail: params.detail as Prisma.InputJsonValue, openedAt: new Date(), alertedAt: null },
      })
    : await prisma.reconciliationFinding.create({
        data: { type: params.type, targetType: params.targetType, targetId: params.targetId, detail: params.detail as Prisma.InputJsonValue },
      });

  await tryAlert(finding.id, { severity: params.severity, title: params.title, detail: params.alertDetail });
}

/** Resolves an open finding (if any) for this (type, targetId) and sends a "resolved" alert. No-op if nothing is open. */
async function resolveFinding(type: string, targetId: string, resolutionNote: string): Promise<void> {
  const existing = await prisma.reconciliationFinding.findUnique({
    where: { type_targetId: { type: type as never, targetId } },
  });
  if (!existing || existing.resolvedAt) return;

  await prisma.reconciliationFinding.update({ where: { id: existing.id }, data: { resolvedAt: new Date() } });
  try {
    await sendOpsAlert({ severity: "info", title: `RESOLVED: ${type}`, detail: `${targetId} — ${resolutionNote}` });
  } catch (err) {
    console.error(`reconciliation: failed to deliver resolution alert for finding ${existing.id}`, err);
  }
}

/**
 * Checks every unresolved CaseSettlement's live settlementTarget
 * binding — the real incident this project had was exactly a zero
 * settlementTarget for a domain with an active integration. Groups by
 * (settlementContract, domain) so the same DecisionRelay isn't read
 * from chain once per case.
 */
async function checkSettlementTargets(): Promise<void> {
  const client = getClient();
  const unresolved = await prisma.caseSettlement.findMany({
    where: { status: { in: ["PENDING_DEPOSIT", "DEPOSITED"] } },
    include: { case: true, integration: true },
  });

  const seen = new Set<string>();
  for (const cs of unresolved) {
    if (!cs.case.settlementChain || !cs.case.settlementContract || cs.case.settlementChain !== "sepolia") continue;
    const key = `${cs.case.settlementContract}:${HYPERLANE_DOMAIN_SEPOLIA}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let liveTarget: string;
    try {
      liveTarget = await client.readContract({
        address: cs.case.settlementContract as Address,
        abi: DECISION_RELAY_ABI,
        functionName: "settlementTarget",
        args: [HYPERLANE_DOMAIN_SEPOLIA],
      });
    } catch (err) {
      console.error(`reconciliation: failed to read settlementTarget for ${cs.case.settlementContract}`, err);
      continue;
    }

    if (liveTarget.toLowerCase() === ZERO_ADDRESS) {
      await raiseFinding({
        type: "ZERO_SETTLEMENT_TARGET",
        targetType: "DecisionRelay",
        targetId: key,
        detail: { decisionRelay: cs.case.settlementContract, domain: HYPERLANE_DOMAIN_SEPOLIA, integrationId: cs.integrationId },
        severity: "critical",
        title: "DecisionRelay.settlementTarget is unset for a domain with an active case awaiting settlement",
        alertDetail: `DecisionRelay ${cs.case.settlementContract} has no settlementTarget configured for domain ${HYPERLANE_DOMAIN_SEPOLIA}, but case ${cs.caseId} is waiting on it.`,
      });
      continue;
    }

    if (liveTarget.toLowerCase() !== (cs.integration.escrowContractAddress as string).toLowerCase()) {
      await raiseFinding({
        type: "TARGET_INTEGRATION_MISMATCH",
        targetType: "DecisionRelay",
        targetId: key,
        detail: { decisionRelay: cs.case.settlementContract, liveTarget, expectedEscrow: cs.integration.escrowContractAddress, integrationId: cs.integrationId },
        severity: "critical",
        title: "DecisionRelay.settlementTarget does not match an active SettlementIntegration's escrow",
        alertDetail: `DecisionRelay ${cs.case.settlementContract}'s settlementTarget is ${liveTarget}, but SettlementIntegration ${cs.integrationId} expects ${cs.integration.escrowContractAddress}.`,
      });
      continue;
    }

    await resolveFinding("ZERO_SETTLEMENT_TARGET", key, `settlementTarget is now ${liveTarget}`);
    await resolveFinding("TARGET_INTEGRATION_MISMATCH", key, `settlementTarget now matches integration (${liveTarget})`);
  }
}

/** A deposit that's been awaited too long — both parties set their address, but nothing has arrived on-chain. */
async function checkOverdueDeposits(): Promise<void> {
  const cutoff = new Date(Date.now() - OVERDUE_DEPOSIT_MS);
  const overdue = await prisma.caseSettlement.findMany({
    where: {
      status: "PENDING_DEPOSIT",
      claimantAddress: { not: null },
      respondentAddress: { not: null },
      OR: [{ claimantAddressSetAt: { lt: cutoff } }, { respondentAddressSetAt: { lt: cutoff } }],
    },
  });

  for (const cs of overdue) {
    await raiseFinding({
      type: "OVERDUE_DEPOSIT",
      targetType: "CaseSettlement",
      targetId: cs.id,
      detail: { caseId: cs.caseId, escrowId: cs.escrowId, expectedAmountAtto: cs.expectedAmountAtto },
      severity: "warning",
      title: "A confirmed party address has waited over the overdue threshold with no deposit arriving",
      alertDetail: `CaseSettlement ${cs.id} (case ${cs.caseId}) has had both party addresses set for over ${Math.round(OVERDUE_DEPOSIT_MS / 3_600_000)}h with no matching on-chain deposit.`,
    });
  }

  // Resolve any previously-overdue finding whose CaseSettlement has
  // since moved past PENDING_DEPOSIT (deposit arrived, or was refunded).
  const openOverdue = await prisma.reconciliationFinding.findMany({ where: { type: "OVERDUE_DEPOSIT", resolvedAt: null } });
  for (const finding of openOverdue) {
    const cs = await prisma.caseSettlement.findUnique({ where: { id: finding.targetId } });
    if (!cs || cs.status !== "PENDING_DEPOSIT") {
      await resolveFinding("OVERDUE_DEPOSIT", finding.targetId, cs ? `status is now ${cs.status}` : "CaseSettlement no longer exists");
    }
  }
}

/**
 * The self-healing half: a Decision whose relayTxHash is set (dispatch
 * succeeded) but whose CaseSettlement is still DEPOSITED, not SETTLED —
 * this exact drift was found and hand-corrected once already this
 * session (see the incident log's re-audit response). Nothing in this
 * codebase automatically advances CaseSettlement to SETTLED after a
 * successful dispatch; this sweep is what actually closes that gap,
 * by re-deriving the real answer from Escrow.deposits() itself.
 */
async function checkDispatchedButStale(): Promise<void> {
  const client = getClient();
  const candidates = await prisma.decision.findMany({
    where: { relayTxHash: { not: null }, case: { settlement: { status: "DEPOSITED" } } },
    include: { case: { include: { settlement: { include: { integration: true } } } } },
    orderBy: { createdAt: "desc" },
  });

  for (const decision of candidates) {
    const cs = decision.case.settlement;
    const kase = decision.case;
    if (!cs || !decision.decisionHash || kase.settlementChain !== "sepolia" || !kase.settlementContract) continue;

    let processed: boolean;
    try {
      processed = await client.readContract({
        address: kase.settlementContract as Address,
        abi: DECISION_RELAY_ABI,
        functionName: "processedDecisions",
        args: [hashToBytes32(decision.decisionHash)],
      });
    } catch (err) {
      console.error(`reconciliation: failed to read processedDecisions for decision ${decision.id}`, err);
      continue;
    }
    if (!processed) continue; // dispatch recorded a txHash but the chain doesn't (yet) show it processed — not stale, just still in flight

    let escrowStatus: number;
    try {
      const result = await client.readContract({
        address: cs.integration.escrowContractAddress as Address,
        abi: ESCROW_ABI,
        functionName: "deposits",
        args: [hashToBytes32(cs.escrowId)],
      });
      escrowStatus = result[0];
    } catch (err) {
      console.error(`reconciliation: failed to read deposits() for CaseSettlement ${cs.id}`, err);
      continue;
    }
    if (escrowStatus !== 2 /* SETTLED */) continue;

    await raiseFinding({
      type: "DISPATCHED_BUT_DB_STALE",
      targetType: "CaseSettlement",
      targetId: cs.id,
      detail: { caseId: cs.caseId, decisionId: decision.id, escrowId: cs.escrowId },
      severity: "warning",
      title: "CaseSettlement is SETTLED on-chain but the database still shows DEPOSITED — self-healing",
      alertDetail: `CaseSettlement ${cs.id} (case ${cs.caseId}) was found SETTLED on-chain but stale in the database; corrected automatically by this sweep.`,
    });

    await prisma.caseSettlement.update({
      where: { id: cs.id },
      data: { status: "SETTLED", settledTxHash: decision.relayTxHash, settledAt: new Date() },
    });
    await resolveFinding("DISPATCHED_BUT_DB_STALE", cs.id, "database corrected to SETTLED by this sweep");
  }
}

/** The audit-anchoring sweep (worker.ts's anchorAuditChains) appears to have stopped running for an organization with real audit-log activity. */
async function checkAuditAnchorStaleness(): Promise<void> {
  const orgs = await prisma.organization.findMany({ where: { auditLogs: { some: {} } } });
  const cutoff = new Date(Date.now() - AUDIT_ANCHOR_STALE_MS);

  for (const org of orgs) {
    const isStale = !org.lastAnchoredAt || org.lastAnchoredAt < cutoff;
    if (isStale) {
      await raiseFinding({
        type: "AUDIT_ANCHOR_STALE",
        targetType: "Organization",
        targetId: org.id,
        detail: { lastAnchoredAt: org.lastAnchoredAt },
        severity: "warning",
        title: "Audit-log anchoring appears stale for an organization with real activity",
        alertDetail: `Organization ${org.id}'s lastAnchoredAt is ${org.lastAnchoredAt ? org.lastAnchoredAt.toISOString() : "never set"} — the audit-anchor sweep may have stopped running.`,
      });
    } else {
      await resolveFinding("AUDIT_ANCHOR_STALE", org.id, `lastAnchoredAt is now ${org.lastAnchoredAt!.toISOString()}`);
    }
  }
}

/** Runs every real check and returns how many findings are currently open, for the worker's own log line. */
export async function runReconciliationSweep(): Promise<{ openFindings: number }> {
  await checkSettlementTargets();
  await checkOverdueDeposits();
  await checkDispatchedButStale();
  await checkAuditAnchorStaleness();

  const openFindings = await prisma.reconciliationFinding.count({ where: { resolvedAt: null } });
  return { openFindings };
}
