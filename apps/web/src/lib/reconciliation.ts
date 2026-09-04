import type { Prisma, ReconciliationFindingType } from "@prisma/client";
import { type Address, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { prisma } from "@/lib/prisma";
import { sendOpsAlert } from "@/lib/alerts";
import { depositsAbiForVersion } from "@/lib/escrow-version";
import { logAction } from "@/lib/audit";

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

// Priority 5, item 18/20: the single source of truth for how severe
// each finding type is — used both here (the severity actually sent
// to sendOpsAlert) and by the reconciliation-findings dashboard/API
// for display, so the two can never quietly disagree about how
// urgent a given finding type is.
export const FINDING_SEVERITY: Record<string, "info" | "warning" | "critical"> = {
  ZERO_SETTLEMENT_TARGET: "critical",
  TARGET_INTEGRATION_MISMATCH: "critical",
  ESCROW_VERSION_MISMATCH: "critical",
  OVERDUE_DEPOSIT: "warning",
  DISPATCHED_BUT_DB_STALE: "warning",
  AUDIT_ANCHOR_STALE: "warning",
};

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
export async function tryAlert(findingId: string, alert: { severity: "info" | "warning" | "critical"; title: string; detail: string }): Promise<void> {
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
      const result = (await client.readContract({
        address: cs.integration.escrowContractAddress as Address,
        abi: depositsAbiForVersion(cs.integration.escrowVersion),
        functionName: "deposits",
        args: [hashToBytes32(cs.escrowId)],
      })) as readonly [number, ...unknown[]];
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

/**
 * Priority 3, item 9 (respondent notification) + a real gap this
 * closes along the way: an emergency refund (Item E) happens entirely
 * OUTSIDE the normal decision/dispatch flow — no Decision row is ever
 * created for it, so checkDispatchedButStale above (which is keyed off
 * Decision.relayTxHash) can never notice one completed. Without this,
 * a real emergency refund would settle on-chain and CaseSettlement
 * would sit at DEPOSITED forever, with no notification sent. Scoped
 * to CaseSettlements with NO Decision at all bearing a relayTxHash, so
 * this and checkDispatchedButStale never both claim the same case.
 */
async function checkEmergencyRefundsSettled(): Promise<void> {
  const client = getClient();
  const candidates = await prisma.caseSettlement.findMany({
    where: { status: "DEPOSITED", case: { decisions: { none: { relayTxHash: { not: null } } } } },
    include: { case: true, integration: true },
  });

  for (const cs of candidates) {
    if (cs.integration.escrowVersion !== "V2" || cs.integration.chain !== "sepolia") continue; // emergencyRefund() only exists on V2 Escrow — see Item E
    let escrowStatus: number;
    try {
      const result = (await client.readContract({
        address: cs.integration.escrowContractAddress as Address,
        abi: depositsAbiForVersion("V2"),
        functionName: "deposits",
        args: [hashToBytes32(cs.escrowId)],
      })) as readonly [number, ...unknown[]];
      escrowStatus = result[0];
    } catch (err) {
      console.error(`reconciliation: failed to read deposits() for CaseSettlement ${cs.id} (emergency-refund check)`, err);
      continue;
    }
    if (escrowStatus !== 2 /* SETTLED */) continue; // no Decision.relayTxHash and not SETTLED — genuinely still awaiting normal settlement, not an emergency refund

    await prisma.$transaction(async (tx) => {
      await tx.caseSettlement.update({ where: { id: cs.id }, data: { status: "SETTLED", settledAt: new Date() } });
      await logAction(
        {
          organizationId: cs.case.organizationId,
          action: "case_settlement.emergency_refund_settled",
          targetType: "CaseSettlement",
          targetId: cs.id,
          metadata: { caseId: cs.caseId, escrowId: cs.escrowId },
        },
        tx
      );
    });

    const { dispatchWebhookEvent } = await import("@/lib/webhooks");
    dispatchWebhookEvent({
      organizationId: cs.case.organizationId,
      event: "case.emergency_refund_settled",
      data: { caseId: cs.caseId, caseSettlementId: cs.id, escrowId: cs.escrowId },
    });
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

// Real auto-escalation: a critical finding that's real, alerted, and
// still sitting unacknowledged past a threshold gets a repeated,
// distinctly-labeled escalation alert on its own cadence — separate
// from the one-time "opened" alert. Only critical findings escalate;
// a warning left unacknowledged for an hour isn't the same class of
// problem as funds genuinely at risk. Both durations are real,
// documented operational knobs (see docs/ops-alert-escalation.md),
// not hardcoded assumptions about anyone's actual response time.
const ESCALATION_THRESHOLD_MS = Number(process.env.RECONCILIATION_ESCALATION_THRESHOLD_MS ?? 30 * 60 * 1000); // 30 min default
const ESCALATION_REPEAT_INTERVAL_MS = Number(process.env.RECONCILIATION_ESCALATION_REPEAT_INTERVAL_MS ?? 30 * 60 * 1000); // repeat every 30 min while still unacknowledged

async function escalateUnacknowledgedCriticalFindings(): Promise<number> {
  const now = Date.now();
  const critical = Object.entries(FINDING_SEVERITY)
    .filter(([, severity]) => severity === "critical")
    .map(([type]) => type);

  const candidates = await prisma.reconciliationFinding.findMany({
    where: {
      resolvedAt: null,
      acknowledgedAt: null,
      type: { in: critical as ReconciliationFindingType[] },
      alertedAt: { not: null, lt: new Date(now - ESCALATION_THRESHOLD_MS) },
    },
  });

  let escalatedCount = 0;
  for (const finding of candidates) {
    if (finding.lastEscalatedAt && now - finding.lastEscalatedAt.getTime() < ESCALATION_REPEAT_INTERVAL_MS) continue;

    const minutesOpen = Math.round((now - finding.openedAt.getTime()) / 60_000);
    try {
      const delivered = await sendOpsAlert({
        severity: "critical",
        title: `[ESCALATION] Unacknowledged for ${minutesOpen} minutes: ${finding.type}`,
        detail: `Finding ${finding.id} (${finding.targetType} ${finding.targetId}) was alerted but nobody has acknowledged it yet. See /settings/reconciliation-findings.`,
      });
      if (delivered) {
        await prisma.reconciliationFinding.update({ where: { id: finding.id }, data: { lastEscalatedAt: new Date() } });
        escalatedCount++;
      }
    } catch (err) {
      console.error(`reconciliation: failed to deliver escalation alert for finding ${finding.id}`, err);
    }
  }
  return escalatedCount;
}

/** Runs every real check and returns how many findings are currently open, for the worker's own log line. */
export async function runReconciliationSweep(): Promise<{ openFindings: number; escalated: number }> {
  await checkSettlementTargets();
  await checkOverdueDeposits();
  await checkDispatchedButStale();
  await checkEmergencyRefundsSettled();
  await checkAuditAnchorStaleness();
  const escalated = await escalateUnacknowledgedCriticalFindings();

  const openFindings = await prisma.reconciliationFinding.count({ where: { resolvedAt: null } });
  return { openFindings, escalated };
}
