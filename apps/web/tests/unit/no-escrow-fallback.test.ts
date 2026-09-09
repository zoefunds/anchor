import { describe, it, expect, vi } from "vitest";

// Regression coverage for the real audit finding this fixes: a case
// with no CaseSettlement used to fall back to a hardcoded zero
// escrowId and dispatch anyway. Once DecisionRelay.settlementTarget is
// actually configured (a real, live governance change made this
// session), that same zero-escrowId dispatch would reach
// Escrow.settle() for real instead of being a harmless no-op —
// dispatchDecisionForCase must now refuse outright when there's no
// verified on-chain escrow to bind the settlement to.

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      // isDecisionSettledOnSepolia's own readContract call — must
      // resolve false so the test reaches the CaseSettlement check,
      // not fail earlier on an unrelated "already settled" path.
      readContract: async () => false,
    }),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    caseSettlement: { findUnique: vi.fn().mockResolvedValue(null) },
    // dispatchDecisionForCase unconditionally calls
    // assertKycPolicyRequirementMet (lib/kyc/kyc-gate.ts), which reads
    // prisma.case — a no-bound-policy result makes it a real no-op,
    // matching this suite's actual scope (the no-escrow fallback path).
    case: { findUnique: vi.fn().mockResolvedValue({ policyVersionRecordId: null, policyVersionRecord: null }) },
  },
}));

vi.mock("@anchor/hyperlane-relay", () => ({
  dispatchDecisionRelay: vi.fn(),
  computeDecisionAttestationHash: vi.fn(),
  caseIdToBytes32: () => "0x00",
  HYPERLANE_DOMAIN: { sepolia: 11155111 },
}));

process.env.HYPERLANE_RELAY_PRIVATE_KEY = "0x" + "1".repeat(64);
process.env.HYPERLANE_RELAY_RPC_URL = "https://example.invalid";

const { dispatchDecisionForCase } = await import("@/lib/hyperlane");

describe("dispatchDecisionForCase — no zero-escrow fallback", () => {
  it("refuses to dispatch when the case has no CaseSettlement", async () => {
    await expect(
      dispatchDecisionForCase({
        caseId: "case-with-no-settlement",
        outcome: "REFUND_FULL",
        claimantShareBps: 10000,
        respondentShareBps: 0,
        claimantAmountAtto: 1000000000000000n,
        respondentAmountAtto: 0n,
        settlementChain: "sepolia",
        settlementContract: "0x94f3FF552CC879a36B19b829af3325Ea72cbC71C",
        evidenceHash: "0".repeat(64),
        decisionHash: "1".repeat(64),
      })
    ).rejects.toThrow(/no CaseSettlement/);
  });
});
