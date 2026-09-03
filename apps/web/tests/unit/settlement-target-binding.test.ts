import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression coverage for the re-audit's Phase 1 finding: the app used
// to verify an escrow deposit against CaseSettlement.integration
// without ever checking (a) that DecisionRelay.settlementTarget for
// this origin actually points at that same escrow, (b) that the
// integration is still active, or (c) that this case's own deposit
// status is DEPOSITED. dispatchDecisionForCase must refuse — and for
// a target mismatch, persist MISMATCH_BLOCKED — rather than dispatch
// against a binding no one actually verified.

const mockReadContract = vi.fn();
const mockCaseSettlementUpdate = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: mockReadContract,
    }),
  };
});

const BASE_CASE_SETTLEMENT = {
  id: "cs-1",
  caseId: "case-1",
  escrowId: "0x" + "2".repeat(64),
  claimantAddress: "0x0000000000000000000000000000000000c1a1",
  respondentAddress: "0x0000000000000000000000000000000000b0b1",
  status: "DEPOSITED",
  integration: {
    id: "int-1",
    active: true,
    escrowContractAddress: "0x5314725C32b58d0e1CACa510d491c8492D0BE997",
  },
};

const mockFindUnique = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    caseSettlement: {
      findUnique: mockFindUnique,
      update: mockCaseSettlementUpdate,
    },
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

const DECISION_PARAMS = {
  caseId: "case-1",
  outcome: "REFUND_FULL" as const,
  claimantShareBps: 10000,
  respondentShareBps: 0,
  claimantAmountAtto: 1000000000000000n,
  respondentAmountAtto: 0n,
  settlementChain: "sepolia" as const,
  settlementContract: "0x94f3FF552CC879a36B19b829af3325Ea72cbC71C",
  evidenceHash: "0".repeat(64),
  decisionHash: "1".repeat(64),
};

describe("dispatchDecisionForCase — settlement target binding invariant", () => {
  beforeEach(() => {
    mockReadContract.mockReset();
    mockFindUnique.mockReset();
    mockCaseSettlementUpdate.mockReset();
  });

  it("refuses when the integration is not active", async () => {
    mockFindUnique.mockResolvedValue({
      ...BASE_CASE_SETTLEMENT,
      integration: { ...BASE_CASE_SETTLEMENT.integration, active: false },
    });
    mockReadContract.mockResolvedValueOnce(false); // isDecisionSettledOnSepolia

    await expect(dispatchDecisionForCase(DECISION_PARAMS)).rejects.toThrow(/not active/);
  });

  it("refuses when CaseSettlement.status is not DEPOSITED", async () => {
    mockFindUnique.mockResolvedValue({
      ...BASE_CASE_SETTLEMENT,
      status: "PENDING_DEPOSIT",
    });
    mockReadContract.mockResolvedValueOnce(false); // isDecisionSettledOnSepolia

    await expect(dispatchDecisionForCase(DECISION_PARAMS)).rejects.toThrow(/not DEPOSITED/);
  });

  it("refuses and persists MISMATCH_BLOCKED when settlementTarget is unconfigured", async () => {
    mockFindUnique.mockResolvedValue({ ...BASE_CASE_SETTLEMENT });
    mockReadContract
      .mockResolvedValueOnce(false) // isDecisionSettledOnSepolia
      .mockResolvedValueOnce("0x0000000000000000000000000000000000000000"); // settlementTarget

    await expect(dispatchDecisionForCase(DECISION_PARAMS)).rejects.toThrow(/no settlementTarget configured/);
    expect(mockCaseSettlementUpdate).toHaveBeenCalledWith({
      where: { id: "cs-1" },
      data: { status: "MISMATCH_BLOCKED" },
    });
  });

  it("refuses and persists MISMATCH_BLOCKED when settlementTarget points at a different escrow", async () => {
    mockFindUnique.mockResolvedValue({ ...BASE_CASE_SETTLEMENT });
    mockReadContract
      .mockResolvedValueOnce(false) // isDecisionSettledOnSepolia
      .mockResolvedValueOnce("0x000000000000000000000000000000deadbeef"); // settlementTarget (wrong escrow)

    await expect(dispatchDecisionForCase(DECISION_PARAMS)).rejects.toThrow(/will not actually pay out to/);
    expect(mockCaseSettlementUpdate).toHaveBeenCalledWith({
      where: { id: "cs-1" },
      data: { status: "MISMATCH_BLOCKED" },
    });
  });
});
