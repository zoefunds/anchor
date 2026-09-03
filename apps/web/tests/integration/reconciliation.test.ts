import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

// Item F coverage: reconciliation must (a) detect each real drift
// condition from live on-chain state, (b) alert exactly once per
// opened finding (not every sweep tick), (c) resolve a finding and
// send exactly one resolution alert once the drift is actually gone,
// and (d) self-heal the one gap this codebase genuinely has — nothing
// ever sets CaseSettlement.status to SETTLED automatically.

const mockReadContract = vi.fn();
const mockSendOpsAlert = vi.fn().mockResolvedValue(true);

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ readContract: mockReadContract }),
  };
});

vi.mock("@/lib/alerts", () => ({
  sendOpsAlert: mockSendOpsAlert,
}));

process.env.HYPERLANE_RELAY_RPC_URL = "https://example.invalid";

const { prisma } = await import("@/lib/prisma");
const { runReconciliationSweep } = await import("@/lib/reconciliation");

const DECISION_RELAY = "0x94f3FF552CC879a36B19b829af3325Ea72cbC71C";
const ESCROW = "0x5314725C32b58d0e1CACa510d491c8492D0BE997";
const CLAIMANT = "0x0000000000000000000000000000000000c1a1";
const RESPONDENT = "0x0000000000000000000000000000000000b0b1";

let orgId: string;
const caseIds: string[] = [];
const integrationIds: string[] = [];

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "reconciliation-test-org" } });
  orgId = org.id;
});

afterEach(async () => {
  vi.clearAllMocks();
  await prisma.reconciliationFinding.deleteMany({});
  await prisma.decision.deleteMany({ where: { caseId: { in: caseIds } } });
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

async function makeIntegration() {
  const integration = await prisma.settlementIntegration.create({
    data: { organizationId: orgId, chain: "sepolia", escrowContractAddress: ESCROW, assetSymbol: "ETH", assetDecimals: 18, createdByMemberId: "test-member" },
  });
  integrationIds.push(integration.id);
  return integration;
}

async function makeCase(overrides: Record<string, unknown> = {}) {
  const kase = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim: "reconciliation test",
      amount: "1",
      claimantRef: "claimant-ref",
      respondentRef: "respondent-ref",
      policyId: "policy-1",
      policyVersion: "v1",
      settlementChain: "sepolia",
      settlementContract: DECISION_RELAY,
      ...overrides,
    },
  });
  caseIds.push(kase.id);
  return kase;
}

describe("runReconciliationSweep — settlement target checks", () => {
  it("opens a ZERO_SETTLEMENT_TARGET finding and alerts once", async () => {
    const integration = await makeIntegration();
    const kase = await makeCase();
    await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: "0x00", expectedAmountAtto: "1", status: "PENDING_DEPOSIT", claimantAddress: CLAIMANT, respondentAddress: RESPONDENT },
    });
    mockReadContract.mockResolvedValue("0x0000000000000000000000000000000000000000");

    await runReconciliationSweep();
    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "ZERO_SETTLEMENT_TARGET" } });
    expect(finding).not.toBeNull();
    expect(finding!.resolvedAt).toBeNull();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    expect(mockSendOpsAlert.mock.calls[0][0].severity).toBe("critical");

    // Second tick, same broken state — must NOT alert again.
    await runReconciliationSweep();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("retries alerting a still-open finding whose first alert never actually delivered", async () => {
    // Real regression coverage: sendOpsAlert resolving without
    // throwing (e.g. OPS_ALERT_WEBHOOK_URL unset, or momentarily
    // unset mid-rollout) is not the same as an alert having gone out
    // — a finding must not be silently left "notified" when nothing
    // was ever delivered.
    const integration = await makeIntegration();
    const kase = await makeCase();
    await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: "0x00", expectedAmountAtto: "1", status: "PENDING_DEPOSIT", claimantAddress: CLAIMANT, respondentAddress: RESPONDENT },
    });
    mockReadContract.mockResolvedValue("0x0000000000000000000000000000000000000000");
    mockSendOpsAlert.mockResolvedValueOnce(false); // simulates "not configured" / skipped delivery

    await runReconciliationSweep();
    let finding = await prisma.reconciliationFinding.findFirst({ where: { type: "ZERO_SETTLEMENT_TARGET" } });
    expect(finding!.alertedAt).toBeNull();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);

    // Same broken state, but this time delivery actually succeeds —
    // must retry, since the finding was never actually alerted.
    await runReconciliationSweep();
    finding = await prisma.reconciliationFinding.findFirst({ where: { type: "ZERO_SETTLEMENT_TARGET" } });
    expect(finding!.alertedAt).not.toBeNull();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(2);

    // Now that it's genuinely alerted, a third tick must NOT alert again.
    await runReconciliationSweep();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(2);
  });

  it("opens a TARGET_INTEGRATION_MISMATCH finding when settlementTarget points elsewhere", async () => {
    const integration = await makeIntegration();
    const kase = await makeCase();
    await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: "0x00", expectedAmountAtto: "1", status: "PENDING_DEPOSIT", claimantAddress: CLAIMANT, respondentAddress: RESPONDENT },
    });
    mockReadContract.mockResolvedValue("0x000000000000000000000000000000deadbeef");

    await runReconciliationSweep();
    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "TARGET_INTEGRATION_MISMATCH" } });
    expect(finding).not.toBeNull();
  });

  it("resolves a finding once the drift is gone, with exactly one resolution alert", async () => {
    const integration = await makeIntegration();
    const kase = await makeCase();
    await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: "0x00", expectedAmountAtto: "1", status: "PENDING_DEPOSIT", claimantAddress: CLAIMANT, respondentAddress: RESPONDENT },
    });
    mockReadContract.mockResolvedValue("0x0000000000000000000000000000000000000000");
    await runReconciliationSweep();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);

    mockReadContract.mockResolvedValue(ESCROW); // now matches — fixed
    await runReconciliationSweep();

    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "ZERO_SETTLEMENT_TARGET" } });
    expect(finding!.resolvedAt).not.toBeNull();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(2);
    expect(mockSendOpsAlert.mock.calls[1][0].title).toMatch(/RESOLVED/);
  });
});

describe("runReconciliationSweep — overdue deposits", () => {
  it("flags a PENDING_DEPOSIT settlement whose addresses were set long ago", async () => {
    const integration = await makeIntegration();
    const kase = await makeCase();
    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await prisma.caseSettlement.create({
      data: {
        caseId: kase.id,
        integrationId: integration.id,
        escrowId: "0x00",
        expectedAmountAtto: "1",
        status: "PENDING_DEPOSIT",
        claimantAddress: CLAIMANT,
        claimantAddressSetAt: longAgo,
        respondentAddress: RESPONDENT,
        respondentAddressSetAt: longAgo,
      },
    });
    mockReadContract.mockResolvedValue(ESCROW);

    await runReconciliationSweep();
    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "OVERDUE_DEPOSIT" } });
    expect(finding).not.toBeNull();
  });

  it("does not flag a fresh PENDING_DEPOSIT", async () => {
    const integration = await makeIntegration();
    const kase = await makeCase();
    await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: "0x00", expectedAmountAtto: "1", status: "PENDING_DEPOSIT", claimantAddress: CLAIMANT, respondentAddress: RESPONDENT },
    });
    mockReadContract.mockResolvedValue(ESCROW);

    await runReconciliationSweep();
    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "OVERDUE_DEPOSIT" } });
    expect(finding).toBeNull();
  });
});

describe("runReconciliationSweep — dispatched-but-stale self-healing", () => {
  it("corrects a DEPOSITED CaseSettlement to SETTLED when on-chain proves it, and raises+resolves a finding", async () => {
    const integration = await makeIntegration();
    const kase = await makeCase();
    const cs = await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: "0x00", expectedAmountAtto: "1", status: "DEPOSITED", claimantAddress: CLAIMANT, respondentAddress: RESPONDENT },
    });
    await prisma.decision.create({
      data: {
        caseId: kase.id,
        policyId: "policy-1",
        policyVersion: "v1",
        outcome: "REFUND_FULL",
        consensus: "ACCEPTED",
        decisionHash: "a".repeat(64),
        relayTxHash: "0xrealtx",
      },
    });

    // settlementTarget read isn't hit for this check path (no unresolved
    // PENDING_DEPOSIT/DEPOSITED case with a mismatched target scenario
    // here) — processedDecisions=true, then deposits() status=2 SETTLED.
    mockReadContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "processedDecisions") return true;
      if (args.functionName === "deposits") return [2, CLAIMANT, RESPONDENT, 1n, "0x00"];
      if (args.functionName === "settlementTarget") return ESCROW;
      throw new Error(`unexpected functionName ${args.functionName}`);
    });

    await runReconciliationSweep();

    const updated = await prisma.caseSettlement.findUniqueOrThrow({ where: { id: cs.id } });
    expect(updated.status).toBe("SETTLED");
    expect(updated.settledTxHash).toBe("0xrealtx");

    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "DISPATCHED_BUT_DB_STALE", targetId: cs.id } });
    expect(finding).not.toBeNull();
    expect(finding!.resolvedAt).not.toBeNull(); // raised and immediately resolved by the same sweep that fixed it
  });

  it("does not touch a CaseSettlement when the chain doesn't yet show it settled", async () => {
    const integration = await makeIntegration();
    const kase = await makeCase();
    const cs = await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: "0x00", expectedAmountAtto: "1", status: "DEPOSITED", claimantAddress: CLAIMANT, respondentAddress: RESPONDENT },
    });
    await prisma.decision.create({
      data: { caseId: kase.id, policyId: "policy-1", policyVersion: "v1", outcome: "REFUND_FULL", consensus: "ACCEPTED", decisionHash: "b".repeat(64), relayTxHash: "0xrealtx2" },
    });
    mockReadContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "processedDecisions") return false;
      if (args.functionName === "settlementTarget") return ESCROW;
      throw new Error(`unexpected functionName ${args.functionName}`);
    });

    await runReconciliationSweep();
    const updated = await prisma.caseSettlement.findUniqueOrThrow({ where: { id: cs.id } });
    expect(updated.status).toBe("DEPOSITED");
  });
});

describe("runReconciliationSweep — audit anchor staleness", () => {
  it("flags an organization with real audit activity and a stale/never-set lastAnchoredAt", async () => {
    await prisma.auditLog.create({
      data: { organizationId: orgId, action: "test.action", targetType: "Test", hash: "h1", prevHash: "genesis" },
    });
    mockReadContract.mockResolvedValue(ESCROW);

    await runReconciliationSweep();
    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "AUDIT_ANCHOR_STALE", targetId: orgId } });
    expect(finding).not.toBeNull();
  });
});
