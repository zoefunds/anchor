import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";

// Item F coverage: reconciliation must (a) detect each real drift
// condition from live on-chain state, (b) alert exactly once per
// opened finding (not every sweep tick), (c) resolve a finding and
// send exactly one resolution alert once the drift is actually gone,
// and (d) self-heal the one gap this codebase genuinely has — nothing
// ever sets CaseSettlement.status to SETTLED automatically.

// This file's own timeout, not a global bump: runReconciliationSweep()
// makes ~10 sequential DB round-trips per call, and several tests call
// it 2-3 times — against this project's remote dev Postgres (observed
// ~3s/query in isolation, no local/dockerized alternative configured),
// that easily exceeds the global 15s default on the very first
// (connection-pool-cold) test, which then cascades: a killed test's
// cleanup never runs, and every later test in the file trips a unique
// constraint or an inflated count against the leftover rows. Real
// latency, not a hang — a bounded generous ceiling here is the correct
// fix, not silently raising the suite-wide default for every other
// file too.
// hookTimeout is a SEPARATE default (10s) from testTimeout — afterEach's
// own row-by-row reconciliationFinding cleanup (see below) can take
// longer than that against this remote DB's real per-query latency when
// many rows have accumulated, independent of how long the test body
// itself took.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const mockReadContract = vi.fn();
const mockSendOpsAlert = vi.fn().mockResolvedValue(true);
// Escalation's second channel (ntfy) — not configured in these tests, so it
// mirrors sendNtfyAlert's own real "unconfigured" behavior (resolves false,
// never throws) rather than pretending it delivered.
const mockSendNtfyAlert = vi.fn().mockResolvedValue(false);

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({ readContract: mockReadContract }),
  };
});

vi.mock("@/lib/alerts", () => ({
  sendOpsAlert: mockSendOpsAlert,
  sendNtfyAlert: mockSendNtfyAlert,
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

  // checkOldEscrowRefundEligibility() raises (and alerts on) a durable
  // OLD_ESCROW_REFUND_ELIGIBLE_SOON finding unconditionally on every
  // single runReconciliationSweep() call, real production behavior this
  // suite must not disable. Its FIRST-EVER creation in a fresh DB does
  // send one real alert (raiseFinding only skips alerting once
  // alertedAt is already set) — which would otherwise land inside
  // whichever test in this file happens to call the sweep first,
  // silently inflating that one test's mockSendOpsAlert count by 1 for
  // a reason having nothing to do with what that test asserts. Seeding
  // it here, already alerted, up front means every real test in this
  // file starts from the same steady state instead of depending on
  // file-internal test order.
  // upsert, not create: this finding is durable and — per this file's
  // own afterEach comment — deliberately never deleted between test
  // runs, so a second run against the same (shared, non-ephemeral) dev
  // database must not fail on a unique-constraint collision with a row
  // this same seed step already created earlier.
  await prisma.reconciliationFinding.upsert({
    where: {
      type_targetId: { type: "OLD_ESCROW_REFUND_ELIGIBLE_SOON", targetId: "0x4C7765A6823dc27Eca1DE174FceeAE5048d403e7" },
    },
    create: {
      type: "OLD_ESCROW_REFUND_ELIGIBLE_SOON",
      targetType: "Escrow",
      targetId: "0x4C7765A6823dc27Eca1DE174FceeAE5048d403e7",
      detail: {},
      alertedAt: new Date(),
    },
    update: { alertedAt: new Date() },
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  // OLD_ESCROW_REFUND_ELIGIBLE_SOON is a durable, always-present
  // incident record (see reconciliation.ts's OLD_STUCK_DEPOSIT) that
  // every runReconciliationSweep() call raises unconditionally — wiping
  // it here would make it re-alert (and inflate mockSendOpsAlert's call
  // count) on the very next test's first sweep, unrelated to whatever
  // that test is actually asserting.
  //
  // Deleted ROW BY ROW, not one deleteMany: a real finding a real
  // operator has actually acknowledged through the app carries a
  // ReconciliationFindingEvent row (a separate, unrelated audit trail
  // this test file never creates or owns), and that table's FK is
  // RESTRICT — deleting such a finding throws. Found 2026-09-13:
  // deleteMany is all-or-nothing against a FK violation — one
  // undeletable real row silently left EVERY OTHER qualifying row
  // undeleted too, for the rest of the run (worse than doing nothing:
  // it looked like cleanup succeeded). Doing this one row at a time
  // means only the specific real, undeletable row is ever skipped;
  // every test-created row this file actually owns still gets removed.
  const toDelete = await prisma.reconciliationFinding.findMany({
    where: { type: { not: "OLD_ESCROW_REFUND_ELIGIBLE_SOON" } },
    select: { id: true },
  });
  for (const { id } of toDelete) {
    try {
      await prisma.reconciliationFinding.delete({ where: { id } });
    } catch (err) {
      console.error(`reconciliation.test.ts afterEach: could not delete finding ${id} (likely a real acknowledged finding with an event row) — leaving it and continuing`, err);
    }
  }
  await prisma.decision.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.caseSettlement.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.settlementIntegration.deleteMany({ where: { id: { in: integrationIds } } });
  caseIds.length = 0;
  integrationIds.length = 0;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  // Defensive: this org's Cases should already be gone via each test's
  // own afterEach, but a prior afterEach failure elsewhere in this file
  // (e.g. the reconciliationFinding cleanup above hitting a real
  // acknowledged finding) can leave one behind — Case's FK is RESTRICT,
  // so an unguarded delete here would fail the whole suite over
  // leftover state this final step can just finish cleaning up itself.
  try {
    await prisma.organization.delete({ where: { id: orgId } });
  } catch (err) {
    console.error("reconciliation.test.ts afterAll: organization delete failed (leftover Case row?) — cleaning up directly", err);
    await prisma.decision.deleteMany({ where: { case: { organizationId: orgId } } });
    await prisma.caseSettlement.deleteMany({ where: { case: { organizationId: orgId } } });
    await prisma.case.deleteMany({ where: { organizationId: orgId } });
    await prisma.settlementIntegration.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
  }
});

// checkGovernanceDrift's owner()/attestorThreshold() reads share this
// same mocked readContract — tests that only care about the
// settlement-target check must still answer those two calls with
// values matching the real committed manifest, or every sweep raises a
// spurious GOVERNANCE_DRIFT finding/alert alongside whatever the test is
// actually asserting on. Read directly from the committed manifest
// (not hardcoded here) so this never silently drifts out of sync again
// — a real regression found 2026-09-13: this used to hardcode the
// expected Safe address, which broke the instant the manifest was
// regenerated against a DecisionRelay whose live owner is a known,
// already-flagged EOA rather than the Safe (see deployment-manifest.json's
// own "flags" array for that documented governance gap).
const evmManifest = (await import("../../deployment-manifest.json")).default;
function mockSettlementTargetOnly(settlementTargetValue: string): void {
  mockReadContract.mockImplementation(async (args: { functionName: string }) => {
    if (args.functionName === "owner") return evmManifest.decisionRelay.owner;
    if (args.functionName === "attestorThreshold") return BigInt(evmManifest.decisionRelay.attestorThreshold);
    return settlementTargetValue;
  });
}

async function makeIntegration(overrides: Record<string, unknown> = {}) {
  const integration = await prisma.settlementIntegration.create({
    data: { organizationId: orgId, chain: "sepolia", escrowContractAddress: ESCROW, assetSymbol: "ETH", assetDecimals: 18, createdByMemberId: "test-member", ...overrides },
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
    mockSettlementTargetOnly("0x0000000000000000000000000000000000000000");

    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "ZERO_SETTLEMENT_TARGET" } });
    expect(finding).not.toBeNull();
    expect(finding!.resolvedAt).toBeNull();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);
    expect(mockSendOpsAlert.mock.calls[0][0].severity).toBe("critical");

    // Second tick, same broken state — must NOT alert again.
    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
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
    mockSettlementTargetOnly("0x0000000000000000000000000000000000000000");
    mockSendOpsAlert.mockResolvedValueOnce(false); // simulates "not configured" / skipped delivery

    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
    let finding = await prisma.reconciliationFinding.findFirst({ where: { type: "ZERO_SETTLEMENT_TARGET" } });
    expect(finding!.alertedAt).toBeNull();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);

    // Same broken state, but this time delivery actually succeeds —
    // must retry, since the finding was never actually alerted.
    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
    finding = await prisma.reconciliationFinding.findFirst({ where: { type: "ZERO_SETTLEMENT_TARGET" } });
    expect(finding!.alertedAt).not.toBeNull();
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(2);

    // Now that it's genuinely alerted, a third tick must NOT alert again.
    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(2);
  });

  it("opens a TARGET_INTEGRATION_MISMATCH finding when settlementTarget points elsewhere", async () => {
    const integration = await makeIntegration();
    const kase = await makeCase();
    await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: "0x00", expectedAmountAtto: "1", status: "PENDING_DEPOSIT", claimantAddress: CLAIMANT, respondentAddress: RESPONDENT },
    });
    mockReadContract.mockResolvedValue("0x000000000000000000000000000000deadbeef");

    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "TARGET_INTEGRATION_MISMATCH" } });
    expect(finding).not.toBeNull();
  });

  it("resolves a finding once the drift is gone, with exactly one resolution alert", async () => {
    const integration = await makeIntegration();
    const kase = await makeCase();
    await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: "0x00", expectedAmountAtto: "1", status: "PENDING_DEPOSIT", claimantAddress: CLAIMANT, respondentAddress: RESPONDENT },
    });
    mockSettlementTargetOnly("0x0000000000000000000000000000000000000000");
    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
    expect(mockSendOpsAlert).toHaveBeenCalledTimes(1);

    mockSettlementTargetOnly(ESCROW); // now matches — fixed
    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });

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

    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
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

    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
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

    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });

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

    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
    const updated = await prisma.caseSettlement.findUniqueOrThrow({ where: { id: cs.id } });
    expect(updated.status).toBe("DEPOSITED");
  });
});

describe("runReconciliationSweep — emergency refund settlement detection", () => {
  it("self-heals a CaseSettlement to SETTLED when a V2 escrow shows SETTLED with no Decision.relayTxHash at all (a real emergency refund, not a normal dispatch)", async () => {
    const integration = await makeIntegration({ escrowVersion: "V2" });
    const kase = await makeCase();
    const cs = await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: "0x00", expectedAmountAtto: "1", status: "DEPOSITED", claimantAddress: CLAIMANT, respondentAddress: RESPONDENT },
    });
    // Deliberately NO Decision row at all — an emergency refund never
    // creates one, unlike a normal dispatch.
    mockReadContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "deposits") return [2, CLAIMANT, RESPONDENT, 1n, "0x00", 0n]; // SETTLED, V2 6-field shape
      if (args.functionName === "settlementTarget") return ESCROW;
      throw new Error(`unexpected functionName ${args.functionName}`);
    });

    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
    const updated = await prisma.caseSettlement.findUniqueOrThrow({ where: { id: cs.id } });
    expect(updated.status).toBe("SETTLED");
    expect(updated.settledAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { targetId: cs.id, action: "case_settlement.emergency_refund_settled" } });
    expect(audit).not.toBeNull();
  });

  it("does not touch a V1 escrow's CaseSettlement — emergencyRefund() only exists on V2", async () => {
    const integration = await makeIntegration({ escrowVersion: "V1" });
    const kase = await makeCase();
    const cs = await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: "0x00", expectedAmountAtto: "1", status: "DEPOSITED", claimantAddress: CLAIMANT, respondentAddress: RESPONDENT },
    });
    mockReadContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "settlementTarget") return ESCROW;
      throw new Error(`unexpected functionName ${args.functionName} — deposits() should never be called for a V1 integration by this check`);
    });

    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
    const updated = await prisma.caseSettlement.findUniqueOrThrow({ where: { id: cs.id } });
    expect(updated.status).toBe("DEPOSITED");
  });

  it("leaves a still-DEPOSITED (not yet refunded) V2 escrow alone", async () => {
    const integration = await makeIntegration({ escrowVersion: "V2" });
    const kase = await makeCase();
    const cs = await prisma.caseSettlement.create({
      data: { caseId: kase.id, integrationId: integration.id, escrowId: "0x00", expectedAmountAtto: "1", status: "DEPOSITED", claimantAddress: CLAIMANT, respondentAddress: RESPONDENT },
    });
    mockReadContract.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === "deposits") return [1, CLAIMANT, RESPONDENT, 1n, "0x00", 0n]; // still DEPOSITED, not SETTLED
      if (args.functionName === "settlementTarget") return ESCROW;
      throw new Error(`unexpected functionName ${args.functionName}`);
    });

    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
    const updated = await prisma.caseSettlement.findUniqueOrThrow({ where: { id: cs.id } });
    expect(updated.status).toBe("DEPOSITED");
  });
});

describe("runReconciliationSweep — audit anchor staleness", () => {
  // Real bug found and fixed 2026-09-13 (incident recovery Phase G.2):
  // the old check flagged any org that had EVER had an audit log,
  // purely on lastAnchoredAt's age — a quiet org with nothing new since
  // its last (or only) anchor got flagged forever just because time
  // passed, since anchorAuditChains() only anchors orgs whose hash
  // genuinely grew. These cases replace the old single flag-on-anything
  // test with the actual intended semantics: flag only when real
  // unanchored backlog has itself been sitting past the SLA.
  const OLD_ENOUGH = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3h ago, past the 1h SLA
  const RECENT = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago, within the SLA

  it("flags an active, never-anchored org whose unanchored activity is older than the SLA", async () => {
    await prisma.auditLog.create({
      data: { organizationId: orgId, action: "test.action", targetType: "Test", hash: "audit-anchor-test-h1", prevHash: "genesis", createdAt: OLD_ENOUGH },
    });
    mockReadContract.mockResolvedValue(ESCROW);

    await runReconciliationSweep({ organizationIds: [orgId], escalationFindingIds: [] });
    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "AUDIT_ANCHOR_STALE", targetId: orgId, resolvedAt: null } });
    expect(finding).not.toBeNull();
  });

  it("does NOT flag an org whose only unanchored activity is recent (within the SLA)", async () => {
    const org = await prisma.organization.create({ data: { name: "reconciliation-test-org-recent" } });
    await prisma.auditLog.create({
      data: { organizationId: org.id, action: "test.action", targetType: "Test", hash: "audit-anchor-test-h2", prevHash: "genesis", createdAt: RECENT },
    });
    mockReadContract.mockResolvedValue(ESCROW);

    await runReconciliationSweep({ organizationIds: [org.id], escalationFindingIds: [] });
    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "AUDIT_ANCHOR_STALE", targetId: org.id, resolvedAt: null } });
    expect(finding).toBeNull();
  });

  it("does NOT flag an org whose old activity is already anchored (recovered case)", async () => {
    const org = await prisma.organization.create({ data: { name: "reconciliation-test-org-anchored", lastAnchoredAt: new Date() } });
    await prisma.auditLog.create({
      data: { organizationId: org.id, action: "test.action", targetType: "Test", hash: "audit-anchor-test-h3", prevHash: "genesis", createdAt: OLD_ENOUGH },
    });
    mockReadContract.mockResolvedValue(ESCROW);

    await runReconciliationSweep({ organizationIds: [org.id], escalationFindingIds: [] });
    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "AUDIT_ANCHOR_STALE", targetId: org.id, resolvedAt: null } });
    expect(finding).toBeNull();
  });

  it("resolves a previously-open finding once a fresh anchor covers the old backlog", async () => {
    const org = await prisma.organization.create({ data: { name: "reconciliation-test-org-recovering" } });
    await prisma.auditLog.create({
      data: { organizationId: org.id, action: "test.action", targetType: "Test", hash: "audit-anchor-test-h4", prevHash: "genesis", createdAt: OLD_ENOUGH },
    });
    mockReadContract.mockResolvedValue(ESCROW);
    await runReconciliationSweep({ organizationIds: [org.id], escalationFindingIds: [] });
    expect(await prisma.reconciliationFinding.findFirst({ where: { type: "AUDIT_ANCHOR_STALE", targetId: org.id, resolvedAt: null } })).not.toBeNull();

    await prisma.organization.update({ where: { id: org.id }, data: { lastAnchoredAt: new Date() } });
    await runReconciliationSweep({ organizationIds: [org.id], escalationFindingIds: [] });
    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "AUDIT_ANCHOR_STALE", targetId: org.id, resolvedAt: null } });
    expect(finding).toBeNull();
  });

  it("resolves an org's open finding once the organization itself no longer exists", async () => {
    const org = await prisma.organization.create({ data: { name: "reconciliation-test-org-deleted" } });
    await prisma.auditLog.create({
      data: { organizationId: org.id, action: "test.action", targetType: "Test", hash: "audit-anchor-test-h5", prevHash: "genesis", createdAt: OLD_ENOUGH },
    });
    mockReadContract.mockResolvedValue(ESCROW);
    await runReconciliationSweep({ organizationIds: [org.id], escalationFindingIds: [] });
    expect(await prisma.reconciliationFinding.findFirst({ where: { type: "AUDIT_ANCHOR_STALE", targetId: org.id, resolvedAt: null } })).not.toBeNull();

    await prisma.auditLog.deleteMany({ where: { organizationId: org.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await runReconciliationSweep({ organizationIds: [org.id], escalationFindingIds: [] });
    const finding = await prisma.reconciliationFinding.findFirst({ where: { type: "AUDIT_ANCHOR_STALE", targetId: org.id, resolvedAt: null } });
    expect(finding).toBeNull();
  });

  afterEach(async () => {
    // Each case above (except the first, which reuses the shared orgId)
    // creates its own throwaway org — clean those up so they don't leak
    // across the rest of this file's test suite.
    const orgs = await prisma.organization.findMany({
      where: { name: { in: ["reconciliation-test-org-recent", "reconciliation-test-org-anchored", "reconciliation-test-org-recovering", "reconciliation-test-org-deleted"] } },
      select: { id: true },
    });
    const ids = orgs.map((o) => o.id);
    if (ids.length > 0) {
      await prisma.auditLog.deleteMany({ where: { organizationId: { in: ids } } });
      await prisma.organization.deleteMany({ where: { id: { in: ids } } });
    }
  });
});

describe("runReconciliationSweep — auto-escalation of unacknowledged critical findings", () => {
  it("does not escalate a critical finding before the threshold has elapsed", async () => {
    const finding = await prisma.reconciliationFinding.create({
      data: {
        type: "ZERO_SETTLEMENT_TARGET",
        targetType: "DecisionRelay",
        targetId: "escalation-test-recent",
        detail: {},
        alertedAt: new Date(), // just now — well within the 30-minute default threshold
      },
    });
    mockReadContract.mockResolvedValue(ESCROW); // no real drift for the other checks

    const result = await runReconciliationSweep({ organizationIds: [], escalationFindingIds: [finding.id] });
    expect(result.escalated).toBe(0);
    const updated = await prisma.reconciliationFinding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(updated.lastEscalatedAt).toBeNull();
  });

  it("escalates a critical finding alerted long ago and still unacknowledged, then respects the repeat interval", async () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000); // 1h ago — past the 30-min default threshold
    const finding = await prisma.reconciliationFinding.create({
      data: {
        type: "ZERO_SETTLEMENT_TARGET",
        targetType: "DecisionRelay",
        targetId: "escalation-test-overdue",
        detail: {},
        alertedAt: longAgo,
      },
    });
    mockReadContract.mockResolvedValue(ESCROW);

    const result = await runReconciliationSweep({ organizationIds: [], escalationFindingIds: [finding.id] });
    expect(result.escalated).toBe(1);
    const escalationCall = mockSendOpsAlert.mock.calls.find((c) => (c[0].title as string).includes("[ESCALATION]") && (c[0].detail as string).includes(finding.id));
    expect(escalationCall).toBeDefined();
    expect(escalationCall![0].severity).toBe("critical");

    const updated = await prisma.reconciliationFinding.findUniqueOrThrow({ where: { id: finding.id } });
    expect(updated.lastEscalatedAt).not.toBeNull();

    // A second sweep tick immediately after must NOT escalate again —
    // real repeat-interval discipline, not "once per sweep tick."
    mockSendOpsAlert.mockClear();
    await runReconciliationSweep({ organizationIds: [], escalationFindingIds: [finding.id] });
    const noRepeatCall = mockSendOpsAlert.mock.calls.find((c) => (c[0].detail as string).includes(finding.id));
    expect(noRepeatCall).toBeUndefined();
  });

  it("never escalates a finding once it's been acknowledged", async () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    const finding = await prisma.reconciliationFinding.create({
      data: {
        type: "TARGET_INTEGRATION_MISMATCH",
        targetType: "DecisionRelay",
        targetId: "escalation-test-acknowledged",
        detail: {},
        alertedAt: longAgo,
        acknowledgedAt: new Date(),
        acknowledgedByMemberId: "test-member",
      },
    });
    mockReadContract.mockResolvedValue(ESCROW);

    const result = await runReconciliationSweep({ organizationIds: [], escalationFindingIds: [finding.id] });
    expect(result.escalated).toBe(0);
    const call = mockSendOpsAlert.mock.calls.find((c) => (c[0].detail as string).includes(finding.id));
    expect(call).toBeUndefined();
  });

  it("never escalates a warning-severity finding, only critical", async () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);
    const finding = await prisma.reconciliationFinding.create({
      data: {
        type: "OVERDUE_DEPOSIT", // warning severity per FINDING_SEVERITY
        targetType: "CaseSettlement",
        targetId: "escalation-test-warning",
        detail: {},
        alertedAt: longAgo,
      },
    });
    mockReadContract.mockResolvedValue(ESCROW);

    const result = await runReconciliationSweep({ organizationIds: [], escalationFindingIds: [finding.id] });
    const call = mockSendOpsAlert.mock.calls.find((c) => (c[0].detail as string).includes(finding.id));
    expect(call).toBeUndefined();
    expect(result.escalated).toBe(0);
  });
});
