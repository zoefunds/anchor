import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";

// Exercises the settlement-recovery path (retryFailedSettlements ->
// dispatchSettlementForDecision) against real Postgres, with
// lib/hyperlane's actual on-chain calls mocked out — the specific gap
// the audit flagged ("no integration test coverage for relay
// recovery"). Covers exactly the two properties the last two rounds of
// fixes were about: a concurrent retry can't double-dispatch (the
// relayClaimedAt lease), and a destination-side "already settled"
// signal gets reconciled instead of endlessly retried.

const dispatchDecisionForCase = vi.fn();

vi.mock("@/lib/hyperlane", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hyperlane")>("@/lib/hyperlane");
  return {
    ...actual,
    dispatchDecisionForCase: (...args: unknown[]) => dispatchDecisionForCase(...args),
  };
});

// Imported after the mock so adjudication-service picks up the mocked binding.
const { retryFailedSettlements } = await import("@/lib/adjudication-service");
const { DecisionAlreadySettledError } = await import("@/lib/hyperlane");

let orgId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "relay-recovery-test-org" } });
  orgId = org.id;
});

beforeEach(() => {
  dispatchDecisionForCase.mockReset();
});

afterAll(async () => {
  await prisma.decision.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

async function makeStuckDecision() {
  const kase = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim: "test_claim",
      amount: 100,
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
      decisionHash: "b".repeat(64),
      relayError: "simulated prior failure",
      relayAttempts: 1,
    },
  });
  return { kase, decision };
}

describe("relay recovery — concurrent retry cannot double-dispatch", () => {
  it("only dispatches once when two retry sweeps race on the same decision", async () => {
    const { decision } = await makeStuckDecision();

    let resolveFirst!: () => void;
    const firstCallBlocked = new Promise<void>((resolve) => (resolveFirst = resolve));
    dispatchDecisionForCase.mockImplementation(async () => {
      await firstCallBlocked;
      return { txHash: "0xtxhash", messageId: "0xmsgid" };
    });

    // Fire two "concurrent" sweeps — the second's claim attempt should
    // find the first's lease already held and skip entirely, not queue
    // up and fire once the first releases it.
    const firstSweep = retryFailedSettlements();
    await new Promise((r) => setTimeout(r, 50)); // let the first sweep claim the lease
    const secondSweep = retryFailedSettlements();

    resolveFirst();
    await Promise.all([firstSweep, secondSweep]);

    expect(dispatchDecisionForCase).toHaveBeenCalledTimes(1);

    const updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(updated.relayTxHash).toBe("0xtxhash");
  });
});

describe("relay recovery — destination-side reconciliation", () => {
  it("marks a decision reconciled instead of retrying when the destination already processed it", async () => {
    const { decision } = await makeStuckDecision();

    dispatchDecisionForCase.mockRejectedValue(new DecisionAlreadySettledError(decision.decisionHash!));

    const retried = await retryFailedSettlements();
    expect(retried).toBe(1);

    const updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(updated.relayTxHash).toBe("reconciled:onchain");
    expect(updated.relayError).toBeNull();
  });

  it("does not attempt a decision that has exhausted MAX_RELAY_ATTEMPTS", async () => {
    const { decision } = await makeStuckDecision();
    await prisma.decision.update({ where: { id: decision.id }, data: { relayAttempts: 10 } });

    const retried = await retryFailedSettlements();
    expect(retried).toBe(0);
    expect(dispatchDecisionForCase).not.toHaveBeenCalled();
  });
});
