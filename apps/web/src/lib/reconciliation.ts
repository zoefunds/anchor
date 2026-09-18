import type { Prisma, ReconciliationFindingType } from "@prisma/client";
import { type Address, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getEscrowProgram, deriveCasePda, fetchCaseStatus, keypairWallet } from "@anchor/solana-escrow-client";
import { prisma } from "@/lib/prisma";
import { sendOpsAlert, sendNtfyAlert } from "@/lib/alerts";
import { depositsAbiForVersion } from "@/lib/escrow-version";
import { logAction } from "@/lib/audit";
import { loadEvmDeploymentManifest } from "@/lib/deployment-manifest";

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
// A Decision that started co-signing (pendingAttestationHash /
// pendingSolanaAttestationMessage set) and hasn't reached relayTxHash
// within this window is treated as a stuck signer/quorum, not a
// still-in-progress one — collecting an external attestor's signature
// is a manual, human-timescale action, but leaving it open past a full
// day with no operator visibility is itself the failure this exists to
// catch.
const STALE_PENDING_SIGNATURE_MS = Number(process.env.RECONCILIATION_STALE_SIGNATURE_MS ?? 24 * 60 * 60 * 1000);
// Hyperlane's own validator/relayer SLA on Sepolia testnet is minutes,
// not hours — see docs/hyperlane-integration.md. A dispatched decision
// that hasn't reached DELIVERED within this window points at the
// relayer or validator path, not at Anchor's own dispatch logic (which
// already succeeded by the time relayTxHash is set).
const HYPERLANE_DELIVERY_SLA_MS = Number(process.env.RECONCILIATION_HYPERLANE_DELIVERY_SLA_MS ?? 60 * 60 * 1000);

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
  RELAY_RETRIES_EXHAUSTED: "critical",
  CANARY_SLA_BREACH: "critical",
  STALE_PENDING_SIGNATURE: "critical",
  LATE_HYPERLANE_DELIVERY: "warning",
  MISSING_DECISION_RECORD: "critical",
  GOVERNANCE_DRIFT: "critical",
  OLD_ESCROW_REFUND_ELIGIBLE_SOON: "warning",
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
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "attestorThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
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
  // Real bug found and fixed 2026-09-13: this was a hand-duplicated
  // union of the Prisma enum that had already drifted — it was missing
  // ESCROW_VERSION_MISMATCH, RELAY_RETRIES_EXHAUSTED, and
  // CANARY_SLA_BREACH (all real, already-used finding types elsewhere
  // in this file), silently relying on `as any`-shaped call sites or
  // just not being caught because those call sites happened to compile
  // against a wider inferred type. Deriving from the Prisma enum
  // directly means this can never drift from schema.prisma again.
  type: ReconciliationFindingType;
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
async function checkSettlementTargets(organizationIds?: string[]): Promise<void> {
  const client = getClient();
  const unresolved = await prisma.caseSettlement.findMany({
    where: { status: { in: ["PENDING_DEPOSIT", "DEPOSITED"] }, ...(organizationIds ? { case: { organizationId: { in: organizationIds } } } : {}) },
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
async function checkOverdueDeposits(organizationIds?: string[]): Promise<void> {
  const cutoff = new Date(Date.now() - OVERDUE_DEPOSIT_MS);
  const overdue = await prisma.caseSettlement.findMany({
    where: {
      status: "PENDING_DEPOSIT",
      claimantAddress: { not: null },
      respondentAddress: { not: null },
      OR: [{ claimantAddressSetAt: { lt: cutoff } }, { respondentAddressSetAt: { lt: cutoff } }],
      ...(organizationIds ? { case: { organizationId: { in: organizationIds } } } : {}),
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
async function checkDispatchedButStale(organizationIds?: string[]): Promise<void> {
  const client = getClient();
  const candidates = await prisma.decision.findMany({
    where: {
      relayTxHash: { not: null },
      case: { settlement: { status: "DEPOSITED" }, ...(organizationIds ? { organizationId: { in: organizationIds } } : {}) },
    },
    include: { case: { include: { settlement: { include: { integration: true } } } } },
    orderBy: { createdAt: "desc" },
  });

  for (const decision of candidates) {
    const cs = decision.case.settlement;
    const kase = decision.case;
    if (!cs || !decision.decisionHash || !kase.settlementContract) continue;

    if (kase.settlementChain === "solanatestnet") {
      await checkSolanaDispatchedButStale(cs, kase.settlementContract, decision.relayTxHash);
      continue;
    }
    if (kase.settlementChain !== "sepolia") continue;

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

    // kase.settlementChain !== "sepolia" already continued above, so
    // this integration is structurally EVM (V1/V2) here -- narrowed
    // explicitly rather than cast.
    if (cs.integration.escrowVersion === "SOLANA_V1") {
      console.error(`reconciliation: CaseSettlement ${cs.id} has chain sepolia but escrowVersion SOLANA_V1 -- inconsistent record, skipping`);
      continue;
    }

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
 * Solana counterpart to the sepolia-only self-healing loop above —
 * checkDispatchedButStale's own doc comment ("nothing in this codebase
 * automatically advances CaseSettlement to SETTLED after a successful
 * dispatch") applied unconditionally to every non-sepolia chain, when
 * only Sepolia was actually implemented. Confirmed live: case
 * cmu0xelfd000u6sh8rrl5kskz settled on-chain (attested_settle succeeded,
 * respondent balance moved) but sat at DEPOSITED indefinitely because
 * this branch didn't exist. Re-derives the real answer from the escrow
 * program's own Case.status account field (see chains/solana/programs/
 * escrow/src/lib.rs), the same "never trust the DB's own claim" pattern
 * as the Sepolia check.
 */
async function checkSolanaDispatchedButStale(
  cs: Prisma.CaseSettlementGetPayload<{ include: { integration: true } }>,
  decisionRelayProgramId: string,
  relayTxHash: string | null
): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    console.error(`reconciliation: SOLANA_RPC_URL not set, cannot check CaseSettlement ${cs.id} for stale status`);
    return;
  }
  const connection = new Connection(rpcUrl, "confirmed");
  const escrowProgramId = new PublicKey(cs.integration.escrowContractAddress);
  const program = getEscrowProgram(connection, keypairWallet(Keypair.generate()), escrowProgramId.toBase58());
  const casePda = deriveCasePda(escrowProgramId, cs.escrowId);

  let status: "active" | "disputed" | "settled" | "refunded" | null;
  try {
    status = await fetchCaseStatus(program, casePda);
  } catch (err) {
    console.error(`reconciliation: failed to read escrow case status for CaseSettlement ${cs.id}`, err);
    return;
  }
  if (status !== "settled") return;

  await raiseFinding({
    type: "DISPATCHED_BUT_DB_STALE",
    targetType: "CaseSettlement",
    targetId: cs.id,
    detail: { caseId: cs.caseId, escrowId: cs.escrowId, decisionRelayProgramId },
    severity: "warning",
    title: "CaseSettlement is SETTLED on-chain (Solana) but the database still shows DEPOSITED — self-healing",
    alertDetail: `CaseSettlement ${cs.id} (case ${cs.caseId}) was found SETTLED on Solana but stale in the database; corrected automatically by this sweep.`,
  });

  await prisma.caseSettlement.update({
    where: { id: cs.id },
    data: { status: "SETTLED", settledTxHash: relayTxHash, settledAt: new Date() },
  });
  await resolveFinding("DISPATCHED_BUT_DB_STALE", cs.id, "database corrected to SETTLED by this sweep");
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
async function checkEmergencyRefundsSettled(organizationIds?: string[]): Promise<void> {
  const client = getClient();
  const candidates = await prisma.caseSettlement.findMany({
    where: {
      status: "DEPOSITED",
      case: { decisions: { none: { relayTxHash: { not: null } } }, ...(organizationIds ? { organizationId: { in: organizationIds } } : {}) },
    },
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

/**
 * The audit-anchoring sweep (worker.ts's anchorAuditChains) appears to
 * have stopped running for an organization with real UNANCHORED
 * activity waiting.
 *
 * Real bug found and fixed 2026-09-13 (incident recovery Phase G.2):
 * this used to flag any org that had EVER had any audit log at all,
 * purely based on lastAnchoredAt's age — meaning a quiet org with zero
 * new activity since its last (or only) anchor got flagged forever,
 * simply because time passed. anchorAuditChains() itself only anchors
 * orgs whose audit-log hash has genuinely grown, so "nothing new to
 * anchor" is the CORRECT, healthy state for an inactive org, not a
 * failure. This now only flags an org when it has at least one audit
 * log CREATED AFTER its last anchor that has itself been sitting
 * unanchored longer than the SLA — i.e., there is real backlog the
 * sweep should have picked up and hasn't.
 */
async function checkAuditAnchorStaleness(organizationIds?: string[]): Promise<void> {
  const orgs = await prisma.organization.findMany({
    where: { auditLogs: { some: {} }, ...(organizationIds ? { id: { in: organizationIds } } : {}) },
  });
  const cutoff = new Date(Date.now() - AUDIT_ANCHOR_STALE_MS);

  for (const org of orgs) {
    const oldestUnanchored = await prisma.auditLog.findFirst({
      where: {
        organizationId: org.id,
        ...(org.lastAnchoredAt ? { createdAt: { gt: org.lastAnchoredAt } } : {}),
      },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    const isStale = !!oldestUnanchored && oldestUnanchored.createdAt < cutoff;
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
      // Real bug in this fix's own first pass: this used to assume
      // lastAnchoredAt is always set once isStale is false, but that's
      // no longer true — a never-anchored org whose only activity is
      // recent is also correctly "not stale."
      await resolveFinding(
        "AUDIT_ANCHOR_STALE",
        org.id,
        org.lastAnchoredAt ? `lastAnchoredAt is now ${org.lastAnchoredAt.toISOString()}` : "no unanchored activity has exceeded the SLA"
      );
    }
  }

  // Real gap this closes: an org can be deleted (e.g. a throwaway
  // rehearsal/test org — see docs/v1-v2-escrow-cutover.md) while it has
  // an open AUDIT_ANCHOR_STALE finding. The loop above only visits
  // orgs that still exist, so a finding for a deleted org would
  // otherwise never resolve — findings have no delete API by design
  // (see api/reconciliation-findings), only real state-driven
  // resolution, so this is the only path back to a clean state.
  const openOrgFindings = await prisma.reconciliationFinding.findMany({
    where: { type: "AUDIT_ANCHOR_STALE", resolvedAt: null, ...(organizationIds ? { targetId: { in: organizationIds } } : {}) },
    select: { targetId: true },
  });
  const openTargetIds = [...new Set(openOrgFindings.map((f) => f.targetId))];
  if (openTargetIds.length > 0) {
    const existingOrgIds = new Set((await prisma.organization.findMany({ where: { id: { in: openTargetIds } }, select: { id: true } })).map((o) => o.id));
    for (const targetId of openTargetIds) {
      if (!existingOrgIds.has(targetId)) {
        await resolveFinding("AUDIT_ANCHOR_STALE", targetId, "target organization no longer exists");
      }
    }
  }
}

/**
 * Signer-unavailable / quorum-unavailable, made queryable: a Decision
 * whose co-signing workflow started (pendingAttestationHash for EVM, or
 * pendingSolanaAttestationMessage for Solana) but which never reached
 * relayTxHash within STALE_PENDING_SIGNATURE_MS. The count of collected
 * signatures vs. the deployment manifest's own threshold distinguishes
 * "no signer has responded at all" from "quorum is one signature short"
 * in the alert text, since those need different operators paged.
 */
async function checkStalePendingSignatures(organizationIds?: string[]): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_PENDING_SIGNATURE_MS);
  const orgFilter = organizationIds ? { case: { organizationId: { in: organizationIds } } } : {};

  const evmStuck = await prisma.decision.findMany({
    where: { pendingAttestationHash: { not: null }, relayTxHash: null, createdAt: { lt: cutoff }, ...orgFilter },
  });
  const solanaStuck = await prisma.decision.findMany({
    where: { pendingSolanaAttestationMessage: { not: null }, relayTxHash: null, createdAt: { lt: cutoff }, ...orgFilter },
  });

  // Batched existing-finding lookup, same reasoning as
  // checkLateHyperlaneDelivery: skip a write entirely for a decision
  // that's still stuck but already has an open, already-alerted
  // finding — nothing about it changed since the last tick.
  const stuckIds = [...evmStuck, ...solanaStuck].map((d) => d.id);
  const existingFindings = stuckIds.length
    ? await prisma.reconciliationFinding.findMany({ where: { type: "STALE_PENDING_SIGNATURE", targetId: { in: stuckIds } } })
    : [];
  const existingByDecision = new Map(existingFindings.map((f) => [f.targetId, f]));

  const evmManifest = (() => {
    try {
      return loadEvmDeploymentManifest();
    } catch {
      return null;
    }
  })();
  for (const d of evmStuck) {
    const existing = existingByDecision.get(d.id);
    if (existing && !existing.resolvedAt && existing.alertedAt) continue;
    const collected = d.pendingAttestationSignatures.length;
    const threshold = evmManifest ? Number(evmManifest.decisionRelay.attestorThreshold) : null;
    await raiseFinding({
      type: "STALE_PENDING_SIGNATURE",
      targetType: "Decision",
      targetId: d.id,
      detail: { chain: "sepolia", collected, threshold },
      severity: "critical",
      title: "EVM decision has been awaiting attestor co-signatures for too long",
      alertDetail: `Decision ${d.id} (case ${d.caseId}) has ${collected}${threshold !== null ? `/${threshold}` : ""} attestor signature(s) collected but has not dispatched in over ${Math.round(STALE_PENDING_SIGNATURE_MS / 3_600_000)}h — check attestor pollers. See docs/runbooks/signer-failure.md.`,
    });
  }

  for (const d of solanaStuck) {
    const existing = existingByDecision.get(d.id);
    if (existing && !existing.resolvedAt && existing.alertedAt) continue;
    const attestations = Array.isArray(d.pendingSolanaAttestations) ? (d.pendingSolanaAttestations as unknown[]) : [];
    await raiseFinding({
      type: "STALE_PENDING_SIGNATURE",
      targetType: "Decision",
      targetId: d.id,
      detail: { chain: "solanatestnet", collected: attestations.length },
      severity: "critical",
      title: "Solana decision has been awaiting attestor co-signatures for too long",
      alertDetail: `Decision ${d.id} (case ${d.caseId}) has ${attestations.length} Solana attestor signature(s) collected but has not dispatched in over ${Math.round(STALE_PENDING_SIGNATURE_MS / 3_600_000)}h — check the Solana attestor poller. See docs/runbooks/signer-failure.md.`,
    });
  }

  // Batched resolution too: one query for every currently-open finding's
  // decision, instead of a findUnique per finding.
  const openStale = await prisma.reconciliationFinding.findMany({ where: { type: "STALE_PENDING_SIGNATURE", resolvedAt: null } });
  if (openStale.length > 0) {
    const decisions = await prisma.decision.findMany({ where: { id: { in: openStale.map((f) => f.targetId) } } });
    const decisionById = new Map(decisions.map((d) => [d.id, d]));
    for (const finding of openStale) {
      const d = decisionById.get(finding.targetId);
      if (!d || d.relayTxHash) {
        await resolveFinding("STALE_PENDING_SIGNATURE", finding.targetId, d ? "decision has since dispatched" : "decision no longer exists");
      }
    }
  }
}

/**
 * Late Hyperlane delivery: a Decision dispatched (relayTxHash set) but
 * with no DELIVERED SignerLifecycleEvent recorded within
 * HYPERLANE_DELIVERY_SLA_MS — the relayer/validator path between
 * dispatch and destination-side processing appears stuck. Deliberately
 * reads SignerLifecycleEvent rather than re-deriving delivery from
 * on-chain processedDecisions() here: that's exactly what
 * checkDispatchedButStale already does for the DB-staleness case, and
 * duplicating it would race the same on-chain reads for two different
 * findings.
 */
async function checkLateHyperlaneDelivery(organizationIds?: string[]): Promise<void> {
  const cutoff = new Date(Date.now() - HYPERLANE_DELIVERY_SLA_MS);
  const dispatched = await prisma.decision.findMany({
    where: {
      relayTxHash: { not: null },
      createdAt: { lt: cutoff },
      ...(organizationIds ? { case: { organizationId: { in: organizationIds } } } : {}),
    },
    select: { id: true, caseId: true, relayTxHash: true, createdAt: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  if (dispatched.length === 0) return;

  // Batched, not one findFirst per decision: this table is
  // organization-global and this repo's own test config notes the
  // shared dev DB has no per-test isolation — an N+1 loop here measured
  // real multi-second-per-row latency against it, exceeding vitest's
  // testTimeout. One IN-list query for every candidate decision instead.
  const deliveredEvents = await prisma.signerLifecycleEvent.findMany({
    where: { decisionId: { in: dispatched.map((d) => d.id) }, state: { in: ["DELIVERED", "SETTLED"] } },
    orderBy: { createdAt: "asc" },
  });
  const deliveredByDecision = new Map<string, (typeof deliveredEvents)[number]>();
  for (const ev of deliveredEvents) {
    if (!deliveredByDecision.has(ev.decisionId)) deliveredByDecision.set(ev.decisionId, ev);
  }

  // A second batched lookup, same reasoning as deliveredEvents above:
  // a decision that's still not delivered but ALREADY has an
  // open+alerted finding needs no write at all on this tick — only a
  // brand-new problem or a just-resolved one does. Without this, every
  // sweep tick pays a full create/update round trip per still-open
  // finding forever, not just once when it opens.
  const existingFindings = await prisma.reconciliationFinding.findMany({
    where: { type: "LATE_HYPERLANE_DELIVERY", targetId: { in: dispatched.map((d) => d.id) } },
  });
  const existingByDecision = new Map(existingFindings.map((f) => [f.targetId, f]));

  for (const d of dispatched) {
    const delivered = deliveredByDecision.get(d.id);
    const existing = existingByDecision.get(d.id);
    if (delivered) {
      if (existing && !existing.resolvedAt) {
        await resolveFinding("LATE_HYPERLANE_DELIVERY", d.id, `reached ${delivered.state} at ${delivered.createdAt.toISOString()}`);
      }
      continue;
    }
    if (existing && !existing.resolvedAt && existing.alertedAt) continue; // already open and already alerted — nothing changed
    await raiseFinding({
      type: "LATE_HYPERLANE_DELIVERY",
      targetType: "Decision",
      targetId: d.id,
      detail: { caseId: d.caseId, relayTxHash: d.relayTxHash, dispatchedAt: d.createdAt },
      severity: "warning",
      title: "Dispatched decision has not reached DELIVERED within the Hyperlane SLA",
      alertDetail: `Decision ${d.id} (case ${d.caseId}) dispatched via ${d.relayTxHash} but has no DELIVERED signer-lifecycle event after ${Math.round(HYPERLANE_DELIVERY_SLA_MS / 60_000)} minutes — check relayer/validator health. See docs/runbooks/relayer-failure.md and docs/runbooks/validator-lag.md.`,
    });
  }
}

type MissingDecisionRecord = {
  decisionId: string;
  billableEventCount: bigint;
  firstSeenAt: Date;
  lastSeenAt: Date;
  caseIds: string[];
  eventTypes: string[];
};

/**
 * Catches the production drift found during the 2026-09-15 restore:
 * BillableEvent proved a decision/settlement happened, but the primary
 * Decision row was missing, so the public verifier returned "decision
 * not found." SignerLifecycleEvent also has historical backfilled rows
 * that intentionally predate Decision retention, and canary runs delete
 * synthetic Decision rows by design, so this check is scoped to billable
 * references for non-canary cases: those are the rows public verification
 * and billing both expect to resolve.
 */
async function checkMissingDecisionRecords(organizationIds?: string[]): Promise<void> {
  const orgFilter = organizationIds?.length ? organizationIds : null;
  const missing = await prisma.$queryRaw<MissingDecisionRecord[]>`
    SELECT
      be."subjectId" AS "decisionId",
      COUNT(*)::bigint AS "billableEventCount",
      MIN(be."createdAt") AS "firstSeenAt",
      MAX(be."createdAt") AS "lastSeenAt",
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT be.metadata->>'caseId'), NULL) AS "caseIds",
      ARRAY_REMOVE(ARRAY_AGG(DISTINCT be."eventType"::text), NULL) AS "eventTypes"
    FROM "BillableEvent" be
    LEFT JOIN "Decision" d ON d.id = be."subjectId"
    JOIN "Case" c ON c.id = be.metadata->>'caseId'
    WHERE d.id IS NULL
      AND be."eventType" IN ('ADJUDICATION_RUN', 'SETTLEMENT_COMPLETED')
      AND be.metadata ? 'caseId'
      AND c."isCanary" = false
      AND (
        ${orgFilter}::text[] IS NULL
        OR c."organizationId" = ANY(${orgFilter}::text[])
      )
    GROUP BY be."subjectId"
    ORDER BY MAX(be."createdAt") DESC
    LIMIT 100
  `;

  const missingIds = new Set(missing.map((row) => row.decisionId));
  for (const row of missing) {
    await raiseFinding({
      type: "MISSING_DECISION_RECORD",
      targetType: "Decision",
      targetId: row.decisionId,
      detail: {
        decisionId: row.decisionId,
        billableEventCount: Number(row.billableEventCount),
        caseIds: row.caseIds,
        eventTypes: row.eventTypes,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
      },
      severity: "critical",
      title: "Decision record missing but billable records still reference it",
      alertDetail:
        `Decision ${row.decisionId} is missing from Decision, but billable records still reference it` +
        `${row.caseIds.length ? ` (case ${row.caseIds.join(", ")})` : ""}. ` +
        "Public verification will fail until the Decision row is restored from GenLayer/on-chain evidence.",
    });
  }

  const openFindings = await prisma.reconciliationFinding.findMany({
    where: { type: "MISSING_DECISION_RECORD", resolvedAt: null },
    select: { targetId: true },
  });
  for (const finding of openFindings) {
    if (missingIds.has(finding.targetId)) continue;
    const restored = await prisma.decision.findUnique({ where: { id: finding.targetId }, select: { id: true } });
    if (restored) await resolveFinding("MISSING_DECISION_RECORD", finding.targetId, "Decision row exists again");
  }
}

/**
 * Governance drift: live DecisionRelay.owner()/attestorThreshold vs.
 * the committed deployment-manifest.json's expected values. Distinct
 * from the manifest's own flags[] (a point-in-time snapshot recomputed
 * by scripts/generate-deployment-manifest.ts on demand) — this is the
 * periodic, unattended check that notices a change happened at all,
 * between manual manifest regenerations.
 */
async function checkGovernanceDrift(): Promise<void> {
  let manifest: ReturnType<typeof loadEvmDeploymentManifest>;
  try {
    manifest = loadEvmDeploymentManifest();
  } catch (err) {
    console.error("reconciliation: failed to load EVM deployment manifest for governance-drift check", err);
    return;
  }

  const client = getClient();
  const address = manifest.decisionRelay.address as Address;
  // A bounded timeout, not just a try/catch: an RPC provider (or, in
  // tests, an unmocked readContract call) that never resolves at all
  // must not stall every OTHER reconciliation check behind it in the
  // same sweep tick — this check's own failure mode is "skip this
  // tick," never "block the sweep."
  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("governance-drift read timed out")), 8000))]);
  let owner: string;
  let attestorThreshold: bigint;
  try {
    [owner, attestorThreshold] = await Promise.all([
      withTimeout(client.readContract({ address, abi: DECISION_RELAY_ABI, functionName: "owner" })),
      withTimeout(client.readContract({ address, abi: DECISION_RELAY_ABI, functionName: "attestorThreshold" })),
    ]);
  } catch (err) {
    console.error(`reconciliation: failed to read live governance state for DecisionRelay ${address}`, err);
    return;
  }

  const expectedOwner = manifest.decisionRelay.owner.toLowerCase();
  const expectedThreshold = BigInt(manifest.decisionRelay.attestorThreshold);
  const driftId = `decisionrelay:${address.toLowerCase()}`;

  if (owner.toLowerCase() !== expectedOwner || attestorThreshold !== expectedThreshold) {
    await raiseFinding({
      type: "GOVERNANCE_DRIFT",
      targetType: "DecisionRelay",
      targetId: driftId,
      detail: { address, liveOwner: owner, expectedOwner: manifest.decisionRelay.owner, liveAttestorThreshold: attestorThreshold.toString(), expectedAttestorThreshold: manifest.decisionRelay.attestorThreshold },
      severity: "critical",
      title: "DecisionRelay's live governance configuration no longer matches the committed deployment manifest",
      alertDetail: `DecisionRelay ${address}: owner is ${owner} (expected ${manifest.decisionRelay.owner}), attestorThreshold is ${attestorThreshold} (expected ${manifest.decisionRelay.attestorThreshold}). Regenerate the manifest if this was authorized: scripts/generate-deployment-manifest.ts. See docs/runbooks/safe-governance-config-change.md.`,
    });
  } else {
    await resolveFinding("GOVERNANCE_DRIFT", driftId, "live owner/attestorThreshold match the committed manifest again");
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

// findingIds, when provided, narrows escalation to exactly those
// findings — unlike organizationIds elsewhere in this file, a
// finding's targetId means a different thing per type (Organization
// id, CaseSettlement id, Decision id, a composite "decisionrelay:0x.."
// string, a raw contract address), so there is no single cheap join
// back to an organization generically across every type. Real
// production callers never pass this; it exists so this project's own
// test suite can escalate deterministically against a shared,
// non-ephemeral dev database that also carries real, pre-existing
// critical findings unrelated to any given test.
async function escalateUnacknowledgedCriticalFindings(findingIds?: string[]): Promise<number> {
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
      ...(findingIds ? { id: { in: findingIds } } : {}),
    },
  });

  let escalatedCount = 0;
  for (const finding of candidates) {
    if (finding.lastEscalatedAt && now - finding.lastEscalatedAt.getTime() < ESCALATION_REPEAT_INTERVAL_MS) continue;

    const minutesOpen = Math.round((now - finding.openedAt.getTime()) / 60_000);
    const title = `[ESCALATION] Unacknowledged for ${minutesOpen} minutes: ${finding.type}`;
    // Full detail (including targetId/targetType — real operational/
    // incident info) goes to Slack only, a private, authenticated
    // channel. Security-audit fix: ntfy topics are public pub/sub by
    // default — a hard-to-guess topic name is the only real secret,
    // not a confidentiality boundary equivalent to Slack's — so the
    // ntfy payload carries a generic, non-identifying message instead,
    // pointing whoever's subscribed to the real dashboard rather than
    // leaking which org/integration is affected to anyone who ever
    // learns the topic name.
    const slackDetail = `Finding ${finding.id} (${finding.targetType} ${finding.targetId}) was alerted but nobody has acknowledged it yet. See /settings/reconciliation-findings.`;
    const ntfyDetail = `A critical reconciliation finding has been unacknowledged for ${minutesOpen} minutes. Check /settings/reconciliation-findings for details.`;
    // Two independent channels for escalation specifically (not every
    // alert) — Slack (primary) and ntfy (a real phone push, no
    // signup/credential on ntfy's side). allSettled (not all): a real
    // failure in one channel must not hide a real success in the
    // other — using Promise.all here in an earlier draft meant one
    // channel throwing (not just returning false) would reject the
    // whole pair, losing visibility into whether the OTHER channel
    // actually delivered.
    const [slackResult, ntfyResult] = await Promise.allSettled([
      sendOpsAlert({ severity: "critical", title, detail: slackDetail }),
      sendNtfyAlert({ title, detail: ntfyDetail, priority: "urgent" }),
    ]);
    if (slackResult.status === "rejected") console.error(`reconciliation: Slack escalation alert failed for finding ${finding.id}`, slackResult.reason);
    if (ntfyResult.status === "rejected") console.error(`reconciliation: ntfy escalation alert failed for finding ${finding.id}`, ntfyResult.reason);

    const delivered = (slackResult.status === "fulfilled" && slackResult.value) || (ntfyResult.status === "fulfilled" && ntfyResult.value);
    if (delivered) {
      await prisma.reconciliationFinding.update({ where: { id: finding.id }, data: { lastEscalatedAt: new Date() } });
      escalatedCount++;
    }
  }
  return escalatedCount;
}

/** Runs every real check and returns how many findings are currently open, for the worker's own log line. */
// Incident recovery Phase G.5 (2026-09-13 Sepolia delivery incident) —
// the one known, real deposit stuck in a retired escrow whose
// DecisionRelay is unreachable (see docs/incidents/2026-09-12-sepolia-
// delivery-incident.md for the full story). Recorded as a literal
// constant, not a generic "any old escrow" scan, because this is a
// single specific incident artifact, not a recurring pattern — a new
// instance of "an escrow got retired mid-flight" should get its own
// deliberately-added entry here, never an automatic guess.
const OLD_STUCK_DEPOSIT = {
  escrowContractAddress: "0x4C7765A6823dc27Eca1DE174FceeAE5048d403e7",
  escrowId: "0xa866d50c8cf906d4d757cbbeb76aa0005728fb7fc11776073bb7b4dee72a6e6c",
  claimant: "0x7401c129EDfc26E68FE19309fE461eb3Db1058Eb",
  amountWei: "2000000000000000", // 0.002 ETH
  depositTxHash: "0x8bf05b223759c49fad53486a2050ea90c4a466c5c0d18a7b331db1e36a06aab2",
  // Escrow.sol's own deposits(escrowId).depositedAt + its immutable
  // emergencyRefundTimeoutSeconds (30 days) — read directly on-chain,
  // not computed from an assumption. This escrow's DecisionRelay
  // (0x1fc130416Dc09dff60e0Ea3C8dE8474e8428b3E2) is retired and can
  // never deliver a real settlement, so emergencyRefund() via that
  // DecisionRelay (still gated by the same 2-of-3 attestor threshold —
  // see Escrow.sol's onlyDecisionRelay comment) is the ONLY recovery
  // path; it is not callable before this timestamp regardless of any
  // other fix, and requires real attestor signatures when it is.
  refundEligibleAt: "2026-10-12T13:35:24.000Z",
  retiredDecisionRelay: "0x1fc130416Dc09dff60e0Ea3C8dE8474e8428b3E2",
} as const;

/**
 * Durable, dashboard-visible reminder that a specific deposit is stuck
 * behind a retired DecisionRelay's emergency-refund timeout. Raised
 * once (raiseFinding's own alert-dedup means only one alert ever goes
 * out for this while the finding stays open) so an operator has real
 * advance notice — not auto-executed, per the incident brief's explicit
 * instruction: recovery requires separately authorized governance
 * approval and a rehearsal against the deployed contract's actual
 * access/attestation requirements before ever being run for real.
 */
async function checkOldEscrowRefundEligibility(): Promise<void> {
  await raiseFinding({
    type: "OLD_ESCROW_REFUND_ELIGIBLE_SOON",
    targetType: "Escrow",
    targetId: OLD_STUCK_DEPOSIT.escrowContractAddress,
    detail: OLD_STUCK_DEPOSIT,
    severity: "warning",
    title: "A deposit is locked behind a retired escrow's emergency-refund timeout",
    alertDetail: `Escrow ${OLD_STUCK_DEPOSIT.escrowContractAddress} (escrowId ${OLD_STUCK_DEPOSIT.escrowId}, claimant ${OLD_STUCK_DEPOSIT.claimant}, ${OLD_STUCK_DEPOSIT.amountWei} wei) is unrecoverable through normal settlement (its DecisionRelay, ${OLD_STUCK_DEPOSIT.retiredDecisionRelay}, is retired). emergencyRefund() becomes callable at ${OLD_STUCK_DEPOSIT.refundEligibleAt} and requires real 2-of-3 attestor signatures — this is not automatic. See docs/incidents/2026-09-12-sepolia-delivery-incident.md for the full recovery procedure.`,
  });
}

/**
 * `scope.organizationIds`, when provided, narrows every check that
 * scans organization-owned data (settlements/decisions/orgs) to just
 * those organizations — real production behavior (an unscoped sweep)
 * is exactly what running with no scope, or omitting it, still does.
 * Added for two reasons at once: (1) it's a legitimate operational
 * capability (re-check a single organization on demand, e.g. from an
 * admin action, without a full global sweep), and (2) it's what makes
 * this function's own test suite (tests/integration/reconciliation.test.ts)
 * deterministic against this project's shared, non-ephemeral dev
 * database — real fix for a genuine flake found 2026-09-13: several
 * checks scan ALL organizations/decisions globally with no filter,
 * so as real historical data (accumulated over the project's whole
 * history) aged past staleness/SLA thresholds, sweep tests calling the
 * unscoped function picked up spurious extra alerts that had nothing
 * to do with what each test itself set up, non-deterministically
 * (varying run to run with wall-clock time).
 *
 * checkOldEscrowRefundEligibility and checkGovernanceDrift are
 * deliberately NOT org-scoped — neither is an organization-scan check
 * at all (one fixed record, one fixed contract address). Escalation is
 * scoped differently, via `scope.escalationFindingIds` rather than
 * organizationIds: it scans findings by type/alertedAt/acknowledgedAt
 * with no cheap, generic way to resolve an arbitrary finding's
 * targetId back to an organization across every finding type, so a
 * caller that wants a deterministic escalation count passes the exact
 * finding ids it cares about instead.
 */
export async function runReconciliationSweep(scope?: { organizationIds?: string[]; escalationFindingIds?: string[] }): Promise<{ openFindings: number; escalated: number }> {
  const orgIds = scope?.organizationIds;
  await checkOldEscrowRefundEligibility();
  await checkSettlementTargets(orgIds);
  await checkOverdueDeposits(orgIds);
  await checkDispatchedButStale(orgIds);
  await checkEmergencyRefundsSettled(orgIds);
  await checkAuditAnchorStaleness(orgIds);
  await checkStalePendingSignatures(orgIds);
  await checkLateHyperlaneDelivery(orgIds);
  await checkMissingDecisionRecords(orgIds);
  await checkGovernanceDrift();
  const escalated = await escalateUnacknowledgedCriticalFindings(scope?.escalationFindingIds);

  const openFindings = await prisma.reconciliationFinding.count({ where: { resolvedAt: null } });
  return { openFindings, escalated };
}
