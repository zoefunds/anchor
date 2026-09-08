import { prisma } from "@/lib/prisma";

// Phase 4, item 4 — customer-facing financial records. Deliberately
// plain, well-formed JSON (and an HTML rendering of the same data) —
// not a PDF library — this pass's "real but simpler first version," per
// the phase's own scope guidance. Every receipt binds the case's
// immutable policy version id, the decision's own proof hashes, and the
// real on-chain settlement tx hash where one exists, so a receipt is a
// verifiable pointer into this system's existing audit trail rather
// than free-standing prose.

export class ReceiptError extends Error {}

async function loadCaseForReceipt(caseId: string, organizationId: string) {
  const kase = await prisma.case.findUnique({
    where: { id: caseId },
    include: {
      decisions: { orderBy: { createdAt: "asc" } },
      settlement: { include: { integration: true } },
      policyVersionRecord: true,
      riskAssessment: true,
      review: true,
    },
  });
  if (!kase || kase.organizationId !== organizationId) {
    throw new ReceiptError("case not found");
  }
  return kase;
}

/** A full case statement: lifecycle, policy binding, decision(s), settlement — the "what happened on this case" document. */
export async function buildCaseStatement(caseId: string, organizationId: string) {
  const kase = await loadCaseForReceipt(caseId, organizationId);
  return {
    documentType: "case_statement",
    generatedAt: new Date().toISOString(),
    case: {
      id: kase.id,
      status: kase.status,
      claim: kase.claim,
      amount: kase.amount.toString(),
      currency: kase.currency,
      claimantRef: kase.claimantRef,
      respondentRef: kase.respondentRef,
      createdAt: kase.createdAt.toISOString(),
    },
    policy: kase.policyVersionRecord
      ? {
          policyVersionId: kase.policyVersionRecord.id,
          version: kase.policyVersionRecord.version,
          evidenceDeadlineHours: kase.policyVersionRecord.evidenceDeadlineHours,
          appealWindowHours: kase.policyVersionRecord.appealWindowHours,
          kycRequired: kase.policyVersionRecord.kycRequired,
        }
      : null,
    riskAssessment: kase.riskAssessment
      ? { action: kase.riskAssessment.action, reasons: kase.riskAssessment.reasons, recheckAction: kase.riskAssessment.recheckAction }
      : null,
    review: kase.review ? { trigger: kase.review.trigger, status: kase.review.status, requiresDualApproval: kase.review.requiresDualApproval } : null,
    decisions: kase.decisions.map((d) => ({
      id: d.id,
      outcome: d.outcome,
      consensus: d.consensus,
      claimantShareBps: d.claimantShareBps,
      respondentShareBps: d.respondentShareBps,
      reasonCodes: d.reasonCodes,
      decisionHash: d.decisionHash,
      proofHash: d.proofHash,
      contractCodeHash: d.contractCodeHash,
      adjudicateTxHash: d.adjudicateTxHash,
      createdAt: d.createdAt.toISOString(),
    })),
    settlement: kase.settlement
      ? {
          status: kase.settlement.status,
          chain: kase.settlement.integration.chain,
          assetSymbol: kase.settlement.integration.assetSymbol,
          expectedAmountAtto: kase.settlement.expectedAmountAtto,
          depositTxHash: kase.settlement.depositTxHash,
          settledTxHash: kase.settlement.settledTxHash,
          settledAt: kase.settlement.settledAt?.toISOString() ?? null,
        }
      : null,
  };
}

/** Evidence + decision proof bundle — the independently-verifiable manifest referencing this decision's own hash chain (proofHash/evidenceManifestHash/decisionHash/adjudicateTxHash), same fields the public verify endpoint already exposes. */
export async function buildProofBundle(caseId: string, organizationId: string) {
  const kase = await loadCaseForReceipt(caseId, organizationId);
  const latestDecision = kase.decisions[kase.decisions.length - 1] ?? null;
  return {
    documentType: "evidence_decision_proof_bundle",
    generatedAt: new Date().toISOString(),
    caseId: kase.id,
    policyVersionId: kase.policyVersionRecord?.id ?? null,
    decision: latestDecision
      ? {
          decisionHash: latestDecision.decisionHash,
          proofHash: latestDecision.proofHash,
          contractCodeHash: latestDecision.contractCodeHash,
          evidenceManifestHash: latestDecision.evidenceManifestHash,
          evidenceUsed: latestDecision.evidenceUsed,
          adjudicateTxHash: latestDecision.adjudicateTxHash,
        }
      : null,
    verificationNote: "Recompute decisionHash from the fields above using the same preimage as computeDecisionHash (see lib/adjudication-service.ts) to independently confirm this bundle was not altered.",
  };
}

/** Deposit receipt — proof a real on-chain deposit was confirmed for this case's escrow binding. */
export async function buildDepositReceipt(caseId: string, organizationId: string) {
  const kase = await loadCaseForReceipt(caseId, organizationId);
  if (!kase.settlement || !kase.settlement.depositTxHash) {
    throw new ReceiptError("no confirmed deposit exists for this case");
  }
  return {
    documentType: "deposit_receipt",
    generatedAt: new Date().toISOString(),
    caseId: kase.id,
    policyVersionId: kase.policyVersionRecord?.id ?? null,
    chain: kase.settlement.integration.chain,
    escrowContractAddress: kase.settlement.integration.escrowContractAddress,
    assetSymbol: kase.settlement.integration.assetSymbol,
    expectedAmountAtto: kase.settlement.expectedAmountAtto,
    depositTxHash: kase.settlement.depositTxHash,
    depositConfirmedAt: kase.settlement.depositConfirmedAt?.toISOString() ?? null,
  };
}

/** Release/refund/partial-settlement receipt — the real settlement transaction. */
export async function buildSettlementReceipt(caseId: string, organizationId: string) {
  const kase = await loadCaseForReceipt(caseId, organizationId);
  const latestDecision = kase.decisions[kase.decisions.length - 1] ?? null;
  if (!latestDecision?.relayTxHash) {
    throw new ReceiptError("this case has no dispatched settlement transaction yet");
  }
  return {
    documentType: "settlement_receipt",
    generatedAt: new Date().toISOString(),
    caseId: kase.id,
    policyVersionId: kase.policyVersionRecord?.id ?? null,
    decisionHash: latestDecision.decisionHash,
    outcome: latestDecision.outcome,
    claimantShareBps: latestDecision.claimantShareBps,
    respondentShareBps: latestDecision.respondentShareBps,
    relayTxHash: latestDecision.relayTxHash,
    relayMessageId: latestDecision.relayMessageId,
    settledTxHash: kase.settlement?.settledTxHash ?? null,
    settledAt: kase.settlement?.settledAt?.toISOString() ?? null,
  };
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Normalized CSV export of an org's settlements — for a customer's accounting/reconciliation system. One row per CaseSettlement. */
export async function buildSettlementsCsv(organizationId: string): Promise<string> {
  const settlements = await prisma.caseSettlement.findMany({
    where: { case: { organizationId } },
    include: { case: { include: { policyVersionRecord: true } }, integration: true },
    orderBy: { createdAt: "asc" },
  });

  const header = [
    "case_id",
    "policy_version_id",
    "status",
    "chain",
    "asset_symbol",
    "expected_amount_atto",
    "deposit_tx_hash",
    "deposit_confirmed_at",
    "settled_tx_hash",
    "settled_at",
    "case_amount",
    "case_currency",
  ];
  const rows = settlements.map((s) =>
    [
      s.caseId,
      s.case.policyVersionRecord?.id ?? "",
      s.status,
      s.integration.chain,
      s.integration.assetSymbol,
      s.expectedAmountAtto,
      s.depositTxHash ?? "",
      s.depositConfirmedAt?.toISOString() ?? "",
      s.settledTxHash ?? "",
      s.settledAt?.toISOString() ?? "",
      s.case.amount.toString(),
      s.case.currency,
    ]
      .map((v) => csvEscape(String(v)))
      .join(",")
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}

/** Machine-readable reconciliation export — same rows as the CSV, as structured JSON, plus the org's own audit-anchor hash chain tail for cross-checking. */
export async function buildReconciliationExport(organizationId: string) {
  const settlements = await prisma.caseSettlement.findMany({
    where: { case: { organizationId } },
    include: { case: { include: { policyVersionRecord: true, decisions: { orderBy: { createdAt: "desc" }, take: 1 } } }, integration: true },
    orderBy: { createdAt: "asc" },
  });
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { lastAnchoredHash: true, lastAnchoredAt: true, lastAnchorTxHash: true } });

  return {
    documentType: "reconciliation_export",
    generatedAt: new Date().toISOString(),
    organizationId,
    auditAnchor: org,
    settlements: settlements.map((s) => ({
      caseId: s.caseId,
      policyVersionId: s.case.policyVersionRecord?.id ?? null,
      status: s.status,
      chain: s.integration.chain,
      assetSymbol: s.integration.assetSymbol,
      expectedAmountAtto: s.expectedAmountAtto,
      depositTxHash: s.depositTxHash,
      settledTxHash: s.settledTxHash,
      settledAt: s.settledAt?.toISOString() ?? null,
      decisionHash: s.case.decisions[0]?.decisionHash ?? null,
      caseAmount: s.case.amount.toString(),
      caseCurrency: s.case.currency,
    })),
  };
}
