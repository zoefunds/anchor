import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { prisma } from "@/lib/prisma";

// Regression coverage for the P0 an audit flagged: dispatchSettlementForDecision
// blocking on SETTLEMENT_PAUSED or a settlement-limit gate returned with no
// durable state, so retryFailedSettlements (which only looks at
// relayError-set/relayTxHash-null rows) never picked the decision back up
// once the gate was lifted — a decision finalized while paused/over-limit
// stayed silently unsettled forever. Proves: the gate durably records a
// blocked reason, the retry sweep picks it up, and once the gate is lifted
// it dispatches exactly once (no double-send, no permanent strand).

const dispatchDecisionForCase = vi.fn();

vi.mock("@/lib/hyperlane", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hyperlane")>("@/lib/hyperlane");
  return {
    ...actual,
    dispatchDecisionForCase: (...args: unknown[]) => dispatchDecisionForCase(...args),
  };
});

const { retryFailedSettlements, dispatchSettlementForDecision, SETTLEMENT_BLOCKED_PAUSED, SETTLEMENT_BLOCKED_LIMIT_EXCEEDED } =
  await import("@/lib/adjudication-service");

let orgId: string;
const originalEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "settlement-gate-recovery-test-org" } });
  orgId = org.id;
});

beforeEach(() => {
  dispatchDecisionForCase.mockReset();
  dispatchDecisionForCase.mockResolvedValue({ txHash: "0xtxhash", messageId: "0xmsgid" });
  for (const key of ["SETTLEMENT_PAUSED", "SETTLEMENT_LIMIT_ATTO_SEPOLIA", "SETTLEMENT_LIMIT_ATTO_DEFAULT"]) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await prisma.decision.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

async function makeFreshDecision(amount = 100) {
  const kase = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim: "test_claim",
      amount,
      claimantRef: "A",
      respondentRef: "B",
      policyId: "agent_data_task_v1",
      policyVersion: "1.0.0",
      status: "FINALIZED",
      settlementChain: "sepolia",
      settlementContract: "0x0000000000000000000000000000000000000001",
    },
  });
  const decision = await prisma.decision.create({
    data: {
      caseId: kase.id,
      policyId: "agent_data_task_v1",
      policyVersion: "1.0.0",
      outcome: "RELEASE_FULL",
      claimantShareBps: 10000,
      respondentShareBps: 0,
      reasonCodes: ["ok"],
      evidenceUsed: [],
      consensus: "ACCEPTED",
      proofHash: "a".repeat(64),
      decisionHash: "c".repeat(64),
    },
  });
  return { kase, decision };
}

describe("settlement gate recovery — SETTLEMENT_PAUSED", () => {
  it("durably records the block, then dispatches exactly once after unpausing via the retry sweep", async () => {
    process.env.SETTLEMENT_PAUSED = "true";
    const { kase, decision } = await makeFreshDecision();

    await dispatchSettlementForDecision(kase, decision);
    expect(dispatchDecisionForCase).not.toHaveBeenCalled();

    const blocked = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(blocked.relayError).toBe(SETTLEMENT_BLOCKED_PAUSED);
    expect(blocked.relayTxHash).toBeNull();
    expect(blocked.relayAttempts).toBe(0); // a gate block is not a real attempt

    // Sweep while still paused: stays blocked, still no dispatch.
    const swept = await retryFailedSettlements();
    expect(swept).toBe(1);
    expect(dispatchDecisionForCase).not.toHaveBeenCalled();

    // Unpause and let the retry sweep pick it back up.
    delete process.env.SETTLEMENT_PAUSED;
    const retried = await retryFailedSettlements();
    expect(retried).toBe(1);
    expect(dispatchDecisionForCase).toHaveBeenCalledTimes(1);

    const settled = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(settled.relayTxHash).toBe("0xtxhash");

    // A further sweep must not re-dispatch an already-settled decision.
    await retryFailedSettlements();
    expect(dispatchDecisionForCase).toHaveBeenCalledTimes(1);
  });
});

describe("settlement gate recovery — settlement limit", () => {
  it("durably records the block, then dispatches exactly once after raising the limit via the retry sweep", async () => {
    process.env.SETTLEMENT_LIMIT_ATTO_SEPOLIA = "1"; // far below any real case amount
    const { kase, decision } = await makeFreshDecision(100);

    await dispatchSettlementForDecision(kase, decision);
    expect(dispatchDecisionForCase).not.toHaveBeenCalled();

    const blocked = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(blocked.relayError).toBe(SETTLEMENT_BLOCKED_LIMIT_EXCEEDED);
    expect(blocked.relayAttempts).toBe(0);

    // Raise the limit well above the case amount and let the sweep resume dispatch.
    process.env.SETTLEMENT_LIMIT_ATTO_SEPOLIA = "999999999999999999999999999999";
    const retried = await retryFailedSettlements();
    expect(retried).toBe(1);
    expect(dispatchDecisionForCase).toHaveBeenCalledTimes(1);

    const settled = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(settled.relayTxHash).toBe("0xtxhash");
  });
});
