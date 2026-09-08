import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";

// Regression coverage for historical bug class #5: before Phase 1's
// escalateRelayRetriesExhausted existed, a decision that hit
// MAX_RELAY_ATTEMPTS without ever settling went silent — retryFailedSettlements'
// own query excludes it (relayAttempts < MAX_RELAY_ATTEMPTS), so a
// FINALIZED case could sit permanently unsettled with zero visibility,
// discoverable only by a human noticing after the fact. This proves the
// escalation path actually fires (a SignerLifecycleEvent + a
// ReconciliationFinding get written) the moment a real dispatch attempt
// pushes relayAttempts to MAX_RELAY_ATTEMPTS, not just that the function
// exists.

const dispatchDecisionForCase = vi.fn();

vi.mock("@/lib/hyperlane", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hyperlane")>("@/lib/hyperlane");
  return {
    ...actual,
    dispatchDecisionForCase: (...args: unknown[]) => dispatchDecisionForCase(...args),
  };
});

const { dispatchSettlementForDecision } = await import("@/lib/adjudication-service");

let orgId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "relay-exhausted-escalation-test-org" } });
  orgId = org.id;
});

beforeEach(() => {
  dispatchDecisionForCase.mockReset();
});

afterAll(async () => {
  const decisions = await prisma.decision.findMany({ where: { case: { organizationId: orgId } }, select: { id: true } });
  const decisionIds = decisions.map((d) => d.id);
  await prisma.reconciliationFinding.deleteMany({ where: { type: "RELAY_RETRIES_EXHAUSTED", targetId: { in: decisionIds } } });
  await prisma.signerLifecycleEvent.deleteMany({ where: { decisionId: { in: decisionIds } } });
  await prisma.decision.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

async function makeStuckDecision(relayAttempts: number) {
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
      relayAttempts,
    },
  });
  return { kase, decision };
}

describe("MAX_RELAY_ATTEMPTS exhaustion escalates instead of going silent", () => {
  it("writes an ESCALATED SignerLifecycleEvent and an alerted RELAY_RETRIES_EXHAUSTED finding on the attempt that hits the cap", async () => {
    // MAX_RELAY_ATTEMPTS is 10 (adjudication-service.ts) — start one
    // attempt below it so this dispatch is the one that pushes it over.
    const { kase, decision } = await makeStuckDecision(9);
    dispatchDecisionForCase.mockRejectedValue(new Error("destination RPC unreachable"));

    await dispatchSettlementForDecision(kase, decision);

    const updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(updated.relayAttempts).toBe(10);
    expect(updated.relayTxHash).toBeNull();

    const events = await prisma.signerLifecycleEvent.findMany({ where: { decisionId: decision.id, state: "ESCALATED" } });
    expect(events.length).toBeGreaterThanOrEqual(1);

    const finding = await prisma.reconciliationFinding.findUnique({
      where: { type_targetId: { type: "RELAY_RETRIES_EXHAUSTED", targetId: decision.id } },
    });
    expect(finding).not.toBeNull();
    expect(finding!.resolvedAt).toBeNull();
    // alertedAt is only set once sendOpsAlert actually delivers (see
    // tryAlert's own comment) — no alert webhook is configured in this
    // test env, so the meaningful assertion here is that the finding
    // itself was raised, not that delivery succeeded.
  });

  it("dispatchSettlementForDecision's own MAX_RELAY_ATTEMPTS guard stops it from re-dispatching (and re-escalating) a decision already at the cap", async () => {
    const { kase, decision } = await makeStuckDecision(9);
    dispatchDecisionForCase.mockRejectedValue(new Error("destination RPC unreachable"));
    await dispatchSettlementForDecision(kase, decision);
    expect(dispatchDecisionForCase).toHaveBeenCalledTimes(1);

    // Now already at MAX_RELAY_ATTEMPTS (10) — a second call must be a
    // no-op (see the `relayAttempts >= MAX_RELAY_ATTEMPTS` guard near the
    // top of dispatchSettlementForDecision), not a second real dispatch
    // attempt or a second escalation.
    const stillStuck = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    await dispatchSettlementForDecision(kase, stillStuck);
    expect(dispatchDecisionForCase).toHaveBeenCalledTimes(1);

    const events = await prisma.signerLifecycleEvent.findMany({ where: { decisionId: decision.id, state: "ESCALATED" } });
    expect(events.length).toBe(1);
  });

  it("escalateRelayRetriesExhausted itself is idempotent: calling it twice reuses the same finding row rather than duplicating it", async () => {
    const { decision } = await makeStuckDecision(10);
    const { escalateRelayRetriesExhausted } = await import("@/lib/signer-lifecycle");

    await escalateRelayRetriesExhausted(decision.id, "sepolia", "first call");
    const firstFinding = await prisma.reconciliationFinding.findUniqueOrThrow({
      where: { type_targetId: { type: "RELAY_RETRIES_EXHAUSTED", targetId: decision.id } },
    });

    await escalateRelayRetriesExhausted(decision.id, "sepolia", "second call");
    const findingAfter = await prisma.reconciliationFinding.findUniqueOrThrow({
      where: { type_targetId: { type: "RELAY_RETRIES_EXHAUSTED", targetId: decision.id } },
    });

    expect(findingAfter.id).toBe(firstFinding.id); // same finding row reused, not duplicated
  });
});
