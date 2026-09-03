import { describe, it, expect, vi, beforeEach } from "vitest";

// Regression coverage for the actual P0 fix: dispatchDecisionForCase
// must never settle against an escrow whose real on-chain deposit
// doesn't exactly match what CaseSettlement claims (claimant,
// respondent, total amount), and must refuse to double-settle an
// already-SETTLED deposit or one that was never deposited at all.

const readContract = vi.fn();
// Real V1 shape (128 raw bytes = 4 * 32-byte fields) — satisfies
// verifyEscrowVersionUnchanged's probe (see lib/escrow-version.ts) so
// these tests can focus on assertEscrowDepositMatches's own logic.
const call = vi.fn().mockResolvedValue({ data: `0x${"00".repeat(128)}` });

vi.mock("@/lib/hyperlane", () => ({
  getEvmPublicClient: () => ({ readContract, call }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { settlementIntegration: { findUnique: vi.fn().mockResolvedValue(null) } },
}));

const { assertEscrowDepositMatches, EscrowValidationError } = await import("@/lib/escrow");

const CLAIMANT = "0x0000000000000000000000000000000000000A" as const;
const RESPONDENT = "0x0000000000000000000000000000000000000B" as const;
const OTHER = "0x0000000000000000000000000000000000000C" as const;
const ESCROW_CONTRACT = "0x0000000000000000000000000000000000000D" as const;
const ESCROW_ID = "0x0000000000000000000000000000000000000000000000000000000000001" as const;

beforeEach(() => {
  readContract.mockReset();
});

describe("assertEscrowDepositMatches", () => {
  it("passes when status/claimant/respondent/amount all exactly match", async () => {
    readContract.mockResolvedValue([1, CLAIMANT, RESPONDENT, 1000n]); // status 1 = DEPOSITED
    await expect(
      assertEscrowDepositMatches({
        escrowContractAddress: ESCROW_CONTRACT,
        escrowIdBytes32: ESCROW_ID,
        expectedClaimant: CLAIMANT,
        expectedRespondent: RESPONDENT,
        expectedTotalAmountWei: 1000n,
        integrationId: "test-integration-id",
        escrowVersion: "V1" as const,
      })
    ).resolves.toBeUndefined();
  });

  it("rejects status NONE (never deposited)", async () => {
    readContract.mockResolvedValue([0, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0n]);
    await expect(
      assertEscrowDepositMatches({
        escrowContractAddress: ESCROW_CONTRACT,
        escrowIdBytes32: ESCROW_ID,
        expectedClaimant: CLAIMANT,
        expectedRespondent: RESPONDENT,
        expectedTotalAmountWei: 1000n,
        integrationId: "test-integration-id",
        escrowVersion: "V1" as const,
      })
    ).rejects.toThrow(EscrowValidationError);
  });

  it("rejects status SETTLED (refuses to double-settle)", async () => {
    readContract.mockResolvedValue([2, CLAIMANT, RESPONDENT, 1000n]); // status 2 = SETTLED
    await expect(
      assertEscrowDepositMatches({
        escrowContractAddress: ESCROW_CONTRACT,
        escrowIdBytes32: ESCROW_ID,
        expectedClaimant: CLAIMANT,
        expectedRespondent: RESPONDENT,
        expectedTotalAmountWei: 1000n,
        integrationId: "test-integration-id",
        escrowVersion: "V1" as const,
      })
    ).rejects.toThrow(/already SETTLED/);
  });

  it("rejects a claimant address mismatch", async () => {
    readContract.mockResolvedValue([1, OTHER, RESPONDENT, 1000n]);
    await expect(
      assertEscrowDepositMatches({
        escrowContractAddress: ESCROW_CONTRACT,
        escrowIdBytes32: ESCROW_ID,
        expectedClaimant: CLAIMANT,
        expectedRespondent: RESPONDENT,
        expectedTotalAmountWei: 1000n,
        integrationId: "test-integration-id",
        escrowVersion: "V1" as const,
      })
    ).rejects.toThrow(/claimant mismatch/);
  });

  it("rejects a respondent address mismatch", async () => {
    readContract.mockResolvedValue([1, CLAIMANT, OTHER, 1000n]);
    await expect(
      assertEscrowDepositMatches({
        escrowContractAddress: ESCROW_CONTRACT,
        escrowIdBytes32: ESCROW_ID,
        expectedClaimant: CLAIMANT,
        expectedRespondent: RESPONDENT,
        expectedTotalAmountWei: 1000n,
        integrationId: "test-integration-id",
        escrowVersion: "V1" as const,
      })
    ).rejects.toThrow(/respondent mismatch/);
  });

  it("rejects an amount mismatch (deposited less than the decision requires)", async () => {
    readContract.mockResolvedValue([1, CLAIMANT, RESPONDENT, 999n]);
    await expect(
      assertEscrowDepositMatches({
        escrowContractAddress: ESCROW_CONTRACT,
        escrowIdBytes32: ESCROW_ID,
        expectedClaimant: CLAIMANT,
        expectedRespondent: RESPONDENT,
        expectedTotalAmountWei: 1000n,
        integrationId: "test-integration-id",
        escrowVersion: "V1" as const,
      })
    ).rejects.toThrow(/amount mismatch/);
  });

  it("is case-insensitive on addresses (checksum vs lowercase)", async () => {
    readContract.mockResolvedValue([1, CLAIMANT.toLowerCase(), RESPONDENT.toLowerCase(), 1000n]);
    await expect(
      assertEscrowDepositMatches({
        escrowContractAddress: ESCROW_CONTRACT,
        escrowIdBytes32: ESCROW_ID,
        expectedClaimant: CLAIMANT,
        expectedRespondent: RESPONDENT,
        expectedTotalAmountWei: 1000n,
        integrationId: "test-integration-id",
        escrowVersion: "V1" as const,
      })
    ).resolves.toBeUndefined();
  });
});
