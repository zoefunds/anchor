import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression coverage for governance-spec Phase 0 item 1: a prior version
// of dispatchDecisionForCase's Solana branch returned the same value
// (the attested_settle transaction signature) for both txHash AND
// messageId. That meant relayMessageId in the database was never a real
// Hyperlane message ID for any Solana settlement — the settlement tx and
// the separate Hyperlane notification dispatch (a different transaction,
// on a different chain, with its own Hyperlane-assigned message ID) were
// silently collapsed into one identifier. This test proves the three
// values returned for a Solana settlement are genuinely distinct.

const mockSubmitAttestedSettle = vi.fn();
const mockDispatchToSealevel = vi.fn();
const mockCaseSettlementFindUnique = vi.fn();
const mockAssertSolanaEscrowDepositMatches = vi.fn();

// A bound, DEPOSITED CaseSettlement with both party addresses set — the
// minimum this suite's target function now unconditionally requires
// (see hyperlane.ts's 2026-09-14 fix removing the old "no CaseSettlement
// -> skip the deposit gate" fallback, a real P0 found by an external
// re-review: a Solana case with no CaseSettlement could settle with zero
// on-chain deposit verification, unlike the EVM branch).
const BOUND_CASE_SETTLEMENT = {
  id: "cs-1",
  status: "DEPOSITED",
  claimantAddress: "8uxqqnAUCwn4LuFE3iQvXA4kr6cMhjZdqsSPHHRLUdmX",
  respondentAddress: "EBea3UVndSrNdgdtfuXC6PoN7573GdS43XDoB6pja9fh",
  escrowId: "case-1",
  expectedAmountAtto: "1000000000000000",
  integration: { active: true, chain: "solanatestnet", escrowContractAddress: "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn" },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    caseSettlement: { findUnique: mockCaseSettlementFindUnique },
    // dispatchDecisionForCase unconditionally calls
    // assertKycPolicyRequirementMet (lib/kyc/kyc-gate.ts), which reads
    // prisma.case — a no-bound-policy result makes it a real no-op,
    // matching this suite's actual scope (Solana identifier
    // distinctness, not KYC gating).
    case: { findUnique: vi.fn().mockResolvedValue({ policyVersionRecordId: null, policyVersionRecord: null }) },
  },
}));

vi.mock("@/lib/solana-settle", () => ({
  submitAttestedSettle: mockSubmitAttestedSettle,
}));

vi.mock("@/lib/solana-escrow", () => ({
  assertSolanaEscrowDepositMatches: mockAssertSolanaEscrowDepositMatches,
}));

vi.mock("@anchor/hyperlane-relay", () => ({
  dispatchDecisionRelay: vi.fn(),
  dispatchDecisionRelayToSealevel: mockDispatchToSealevel,
  computeDecisionAttestationHash: vi.fn(),
  caseIdToBytes32: () => "0x00",
  HYPERLANE_DOMAIN: { sepolia: 11155111, solanaTestnet: 1399811150 },
}));

process.env.HYPERLANE_RELAY_PRIVATE_KEY = "0x" + "1".repeat(64);
process.env.HYPERLANE_RELAY_RPC_URL = "https://example.invalid";
process.env.SOLANA_RPC_URL = "https://example.invalid";

const { dispatchDecisionForCase } = await import("@/lib/hyperlane");

const DECISION_PARAMS = {
  caseId: "case-1",
  outcome: "REFUND_FULL" as const,
  claimantShareBps: 10000,
  respondentShareBps: 0,
  claimantAmountAtto: 1000000000000000n,
  respondentAmountAtto: 0n,
  settlementChain: "solanatestnet" as const,
  settlementContract: "DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN",
  settlementSolanaClaimant: "8uxqqnAUCwn4LuFE3iQvXA4kr6cMhjZdqsSPHHRLUdmX",
  settlementSolanaRespondent: "EBea3UVndSrNdgdtfuXC6PoN7573GdS43XDoB6pja9fh",
  settlementSolanaEscrowProgram: "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn",
  settlementSolanaCaseId: "case-1",
  evidenceHash: "0".repeat(64),
  decisionHash: "1".repeat(64),
};

describe("dispatchDecisionForCase — Solana settlement identifiers stay distinct", () => {
  beforeEach(() => {
    mockSubmitAttestedSettle.mockReset();
    mockDispatchToSealevel.mockReset();
    mockCaseSettlementFindUnique.mockReset();
    mockAssertSolanaEscrowDepositMatches.mockReset();
    mockCaseSettlementFindUnique.mockResolvedValue(BOUND_CASE_SETTLEMENT);
    mockAssertSolanaEscrowDepositMatches.mockResolvedValue(undefined); // deposit verified — this suite's scope is identifier distinctness, not deposit-matching itself
  });

  it("returns a real settle signature, a distinct notification tx hash, and a distinct Hyperlane message ID", async () => {
    const settleSignature = "5xJ3z" + "s".repeat(80); // stands in for a real base58 Solana tx signature
    const notificationTxHash = "0x" + "a".repeat(64); // a Sepolia tx hash
    const hyperlaneMessageId = "0x" + "b".repeat(64); // Hyperlane's own Dispatch-event message ID

    mockSubmitAttestedSettle.mockResolvedValue({ signature: settleSignature });
    mockDispatchToSealevel.mockResolvedValue({ txHash: notificationTxHash, messageId: hyperlaneMessageId });

    const result = await dispatchDecisionForCase(DECISION_PARAMS);

    expect(result.txHash).toBe(settleSignature);
    expect(result.notificationTxHash).toBe(notificationTxHash);
    expect(result.messageId).toBe(hyperlaneMessageId);

    // The actual regression: these three must never collapse to the same value.
    expect(result.txHash).not.toBe(result.messageId);
    expect(result.txHash).not.toBe(result.notificationTxHash);
    expect(result.notificationTxHash).not.toBe(result.messageId);
  });

  it("returns a null messageId (never the settle signature) when the Hyperlane dispatch fails", async () => {
    // Real bug found by a 2026-09-14 re-review: this used to fall back to
    // the settlement transaction signature, mislabeling it as a Hyperlane
    // message ID in a field literally named for the latter
    // (Decision.relayMessageId). null is correct here — it means "no
    // Hyperlane notification was recorded for this decision," a true and
    // useful fact, not something to paper over with a fabricated value.
    const settleSignature = "5xJ3z" + "s".repeat(80);
    mockSubmitAttestedSettle.mockResolvedValue({ signature: settleSignature });
    mockDispatchToSealevel.mockRejectedValue(new Error("relay rpc unreachable"));

    const result = await dispatchDecisionForCase(DECISION_PARAMS);

    expect(result.txHash).toBe(settleSignature);
    expect(result.messageId).toBeNull();
    expect(result.notificationTxHash).toBeUndefined(); // the absence is the signal the notification dispatch failed
  });
});
