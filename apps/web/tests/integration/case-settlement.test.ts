import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

// Item C coverage: the real on-chain-authoritative parts of the
// CaseSettlement/SettlementIntegration workflow — escrowId derivation,
// the escrow/DecisionRelay binding check done at integration-creation
// and case-bind time, and deposit confirmation, which must only ever
// trust what Escrow.deposits() itself reports, never a caller claim.
// Runs against a real local Postgres (like the other tests/integration
// suites) with viem's readContract mocked, since there is no real
// Sepolia state to assert against in CI.

const mockReadContract = vi.fn();
const mockGetBlockNumber = vi.fn();
const mockGetLogs = vi.fn();

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      readContract: mockReadContract,
      getBlockNumber: mockGetBlockNumber,
      getLogs: mockGetLogs,
    }),
  };
});

process.env.HYPERLANE_RELAY_RPC_URL = "https://example.invalid";

const { prisma } = await import("@/lib/prisma");
const {
  deriveEscrowId,
  assertEscrowBoundToDecisionRelay,
  checkAndConfirmDeposit,
  SettlementIntegrationError,
} = await import("@/lib/case-settlement");

const DECISION_RELAY = "0x94f3FF552CC879a36B19b829af3325Ea72cbC71C";
const ESCROW = "0x5314725C32b58d0e1CACa510d491c8492D0BE997";
const CLAIMANT = "0x0000000000000000000000000000000000c1a1";
const RESPONDENT = "0x0000000000000000000000000000000000b0b1";

let orgId: string;
const caseIds: string[] = [];
const integrationIds: string[] = [];

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "case-settlement-test-org" } });
  orgId = org.id;
});

afterEach(async () => {
  vi.clearAllMocks();
  await prisma.caseSettlement.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.settlementIntegration.deleteMany({ where: { id: { in: integrationIds } } });
  caseIds.length = 0;
  integrationIds.length = 0;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
});

async function makeCaseAndIntegration(overrides: { claimantAddress?: string | null; respondentAddress?: string | null } = {}) {
  const kase = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim: "case-settlement test",
      amount: "1",
      claimantRef: "claimant-ref",
      respondentRef: "respondent-ref",
      policyId: "policy-1",
      policyVersion: "v1",
      settlementChain: "sepolia",
      settlementContract: DECISION_RELAY,
    },
  });
  caseIds.push(kase.id);

  const integration = await prisma.settlementIntegration.create({
    data: {
      organizationId: orgId,
      chain: "sepolia",
      escrowContractAddress: ESCROW,
      assetSymbol: "ETH",
      assetDecimals: 18,
      createdByMemberId: "test-member",
    },
  });
  integrationIds.push(integration.id);

  const settlement = await prisma.caseSettlement.create({
    data: {
      caseId: kase.id,
      integrationId: integration.id,
      escrowId: deriveEscrowId(kase.id),
      expectedAmountAtto: "1000000000000000000",
      claimantAddress: overrides.claimantAddress === undefined ? CLAIMANT : overrides.claimantAddress,
      respondentAddress: overrides.respondentAddress === undefined ? RESPONDENT : overrides.respondentAddress,
    },
  });

  return { kase, integration, settlement };
}

describe("deriveEscrowId", () => {
  it("is deterministic for the same caseId", () => {
    expect(deriveEscrowId("case-abc")).toBe(deriveEscrowId("case-abc"));
  });

  it("differs across caseIds", () => {
    expect(deriveEscrowId("case-abc")).not.toBe(deriveEscrowId("case-xyz"));
  });
});

describe("assertEscrowBoundToDecisionRelay", () => {
  it("passes when the escrow's decisionRelay() matches", async () => {
    mockReadContract.mockResolvedValueOnce(DECISION_RELAY);
    await expect(
      assertEscrowBoundToDecisionRelay({ chain: "sepolia", escrowContractAddress: ESCROW, expectedDecisionRelayAddress: DECISION_RELAY })
    ).resolves.toBeUndefined();
  });

  it("throws SettlementIntegrationError when the escrow points at a different relay", async () => {
    mockReadContract.mockResolvedValueOnce("0x000000000000000000000000000000deadbeef");
    await expect(
      assertEscrowBoundToDecisionRelay({ chain: "sepolia", escrowContractAddress: ESCROW, expectedDecisionRelayAddress: DECISION_RELAY })
    ).rejects.toThrow(SettlementIntegrationError);
  });
});

describe("checkAndConfirmDeposit", () => {
  it("returns not_ready when a party address is still unset", async () => {
    const { settlement } = await makeCaseAndIntegration({ respondentAddress: null });
    const result = await checkAndConfirmDeposit(settlement.id);
    expect(result.outcome).toBe("not_ready");
  });

  it("returns no_deposit_yet when the escrow has no deposit for this escrowId", async () => {
    const { settlement } = await makeCaseAndIntegration();
    mockReadContract.mockResolvedValueOnce([0, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000000", 0n, "0x00"]);
    const result = await checkAndConfirmDeposit(settlement.id);
    expect(result.outcome).toBe("no_deposit_yet");
  });

  it("returns not_ready when the on-chain claimant doesn't match what the party set", async () => {
    const { settlement } = await makeCaseAndIntegration();
    mockReadContract.mockResolvedValueOnce([1, "0x000000000000000000000000000000ffffffff", RESPONDENT, 1000000000000000000n, "0x00"]);
    const result = await checkAndConfirmDeposit(settlement.id);
    expect(result.outcome).toBe("not_ready");
    if (result.outcome === "not_ready") expect(result.reason).toMatch(/claimant/);
  });

  it("returns not_ready on amount mismatch", async () => {
    const { settlement } = await makeCaseAndIntegration();
    mockReadContract.mockResolvedValueOnce([1, CLAIMANT, RESPONDENT, 1n, "0x00"]);
    const result = await checkAndConfirmDeposit(settlement.id);
    expect(result.outcome).toBe("not_ready");
    if (result.outcome === "not_ready") expect(result.reason).toMatch(/amount/);
  });

  it("confirms and persists DEPOSITED when on-chain state matches exactly", async () => {
    const { settlement } = await makeCaseAndIntegration();
    mockReadContract.mockResolvedValueOnce([1, CLAIMANT, RESPONDENT, 1000000000000000000n, "0x00"]);
    mockGetBlockNumber.mockResolvedValueOnce(1000n);
    mockGetLogs.mockResolvedValueOnce([{ transactionHash: "0xrealtxhash" }]);

    const result = await checkAndConfirmDeposit(settlement.id);
    expect(result.outcome).toBe("confirmed");
    if (result.outcome === "confirmed") expect(result.txHash).toBe("0xrealtxhash");

    const updated = await prisma.caseSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
    expect(updated.status).toBe("DEPOSITED");
    expect(updated.depositTxHash).toBe("0xrealtxhash");
    expect(updated.depositConfirmedAt).not.toBeNull();
  });

  it("is idempotent — already_confirmed on a second call", async () => {
    const { settlement } = await makeCaseAndIntegration();
    mockReadContract.mockResolvedValueOnce([1, CLAIMANT, RESPONDENT, 1000000000000000000n, "0x00"]);
    mockGetBlockNumber.mockResolvedValueOnce(1000n);
    mockGetLogs.mockResolvedValueOnce([]);
    await checkAndConfirmDeposit(settlement.id);

    const second = await checkAndConfirmDeposit(settlement.id);
    expect(second.outcome).toBe("already_confirmed");
  });
});
