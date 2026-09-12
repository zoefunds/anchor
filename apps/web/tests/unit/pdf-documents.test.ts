import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/receipts", () => ({
  buildCaseStatement: vi.fn(async () => ({
    documentType: "case_statement",
    generatedAt: "2026-09-08T00:00:00.000Z",
    case: {
      id: "case_1",
      status: "SETTLED",
      claim: "Item not delivered",
      amount: "100.00",
      currency: "USD",
      claimantRef: "claimant_1",
      respondentRef: "respondent_1",
      createdAt: "2026-09-01T00:00:00.000Z",
    },
    policy: { policyVersionId: "pv_1", version: "1.2.0", evidenceDeadlineHours: 72, appealWindowHours: 48, kycRequired: false },
    decisions: [
      {
        id: "dec_1",
        outcome: "CLAIMANT_WINS",
        consensus: "UNANIMOUS",
        claimantShareBps: 10000,
        respondentShareBps: 0,
        reasonCodes: ["EVIDENCE_SUFFICIENT"],
        decisionHash: "0xdecisionhash",
        proofHash: "0xproofhash",
        contractCodeHash: "0xcodehash",
        adjudicateTxHash: "0xtxhash",
        createdAt: "2026-09-02T00:00:00.000Z",
      },
    ],
    settlement: {
      status: "SETTLED",
      chain: "sepolia",
      asset: { assetSymbol: "ETH", tokenAddress: null, decimals: 18, atomicAmount: "100000000000000000", humanAmount: "0.1", fiatReferenceUsd: null, fiatReferenceNote: null, testnetNotice: null },
      depositTxHash: "0xdeposit",
      settledTxHash: "0xsettled",
      settledAt: "2026-09-03T00:00:00.000Z",
    },
  })),
  buildProofBundle: vi.fn(async () => ({
    documentType: "evidence_decision_proof_bundle",
    generatedAt: "2026-09-08T00:00:00.000Z",
    caseId: "case_1",
    policyVersionId: "pv_1",
    decision: {
      decisionHash: "0xdecisionhash",
      proofHash: "0xproofhash",
      contractCodeHash: "0xcodehash",
      evidenceManifestHash: "0xmanifest",
      evidenceUsed: ["photo:contenthash1"],
      adjudicateTxHash: "0xtxhash",
    },
    verificationNote: "Recompute decisionHash to verify.",
  })),
  buildDepositReceipt: vi.fn(async () => ({
    documentType: "deposit_receipt",
    generatedAt: "2026-09-08T00:00:00.000Z",
    caseId: "case_1",
    policyVersionId: "pv_1",
    chain: "sepolia",
    escrowContractAddress: "0xescrow",
    asset: { assetSymbol: "ETH", tokenAddress: null, decimals: 18, atomicAmount: "100000000000000000", humanAmount: "0.1", fiatReferenceUsd: null, fiatReferenceNote: null, testnetNotice: null },
    depositTxHash: "0xdeposit",
    depositConfirmedAt: "2026-09-01T12:00:00.000Z",
  })),
  buildSettlementReceipt: vi.fn(async () => ({
    documentType: "settlement_receipt",
    generatedAt: "2026-09-08T00:00:00.000Z",
    caseId: "case_1",
    policyVersionId: "pv_1",
    decisionHash: "0xdecisionhash",
    outcome: "CLAIMANT_WINS",
    claimantShareBps: 10000,
    respondentShareBps: 0,
    relayTxHash: "0xrelay",
    relayMessageId: "msg_1",
    settledTxHash: "0xsettled",
    settledAt: "2026-09-03T00:00:00.000Z",
  })),
  buildDecisionRecord: vi.fn(async () => ({
    documentType: "decision_record",
    generatedAt: "2026-09-08T00:00:00.000Z",
    caseId: "case_1",
    policyVersionId: "pv_1",
    policyVersion: "1.2.0",
    decision: {
      id: "dec_1",
      outcome: "CLAIMANT_WINS",
      consensus: "UNANIMOUS",
      confidence: 0.95,
      claimantShareBps: 10000,
      respondentShareBps: 0,
      reasonCodes: ["EVIDENCE_SUFFICIENT"],
      explanation: "The claimant's evidence was conclusive.",
      decisionHash: "0xdecisionhash",
      proofHash: "0xproofhash",
      contractCodeHash: "0xcodehash",
      adjudicateTxHash: "0xtxhash",
      appealWindowClosesAt: "2026-09-05T00:00:00.000Z",
      createdAt: "2026-09-02T00:00:00.000Z",
    },
  })),
  buildAppealRecord: vi.fn(async () => ({
    documentType: "appeal_record",
    generatedAt: "2026-09-08T00:00:00.000Z",
    caseId: "case_1",
    policyVersionId: "pv_1",
    caseStatus: "APPEALED",
    originalDecision: {
      id: "dec_1",
      outcome: "CLAIMANT_WINS",
      claimantShareBps: 10000,
      respondentShareBps: 0,
      decisionHash: "0xdecisionhash",
      createdAt: "2026-09-02T00:00:00.000Z",
    },
    appealDecision: {
      id: "dec_2",
      outcome: "SPLIT",
      consensus: "MAJORITY",
      claimantShareBps: 5000,
      respondentShareBps: 5000,
      reasonCodes: ["NEW_EVIDENCE"],
      explanation: "New evidence changed the outcome.",
      decisionHash: "0xdecisionhash2",
      proofHash: "0xproofhash2",
      contractCodeHash: "0xcodehash2",
      adjudicateTxHash: "0xtxhash2",
      createdAt: "2026-09-06T00:00:00.000Z",
    },
  })),
}));

import {
  generateCaseStatementPdf,
  generateEvidenceReceiptPdf,
  generateDecisionRecordPdf,
  generateAppealRecordPdf,
  generateSettlementReceiptPdf,
  generateDepositReceiptPdf,
} from "@/lib/pdf-documents";

function assertValidPdf(bytes: Uint8Array) {
  expect(bytes.length).toBeGreaterThan(500);
  const header = Buffer.from(bytes.slice(0, 5)).toString("latin1");
  expect(header).toBe("%PDF-");
}

describe("pdf-documents", () => {
  it("generates a valid case statement PDF", async () => {
    const bytes = await generateCaseStatementPdf("case_1", "org_1");
    assertValidPdf(bytes);
  });

  it("generates a valid settlement receipt PDF", async () => {
    const bytes = await generateSettlementReceiptPdf("case_1", "org_1");
    assertValidPdf(bytes);
  });

  it("generates a valid evidence receipt PDF", async () => {
    const bytes = await generateEvidenceReceiptPdf("case_1", "org_1");
    assertValidPdf(bytes);
  });

  it("generates a valid decision record PDF", async () => {
    const bytes = await generateDecisionRecordPdf("case_1", "org_1");
    assertValidPdf(bytes);
  });

  it("generates a valid appeal record PDF", async () => {
    const bytes = await generateAppealRecordPdf("case_1", "org_1");
    assertValidPdf(bytes);
  });

  it("generates a valid deposit receipt PDF", async () => {
    const bytes = await generateDepositReceiptPdf("case_1", "org_1");
    assertValidPdf(bytes);
  });
});
