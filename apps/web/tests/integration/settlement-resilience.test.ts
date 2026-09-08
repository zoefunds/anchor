import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";

// Phase 2 adversarial matrix: three scenarios not covered by
// tests/integration/relay-recovery.test.ts or settlement-gate-recovery.test.ts —
//
// 1. "worker crash between durable writes" — the on-chain dispatch
//    genuinely succeeds but the very next DB write (persisting
//    relayTxHash) is lost, simulating a process crash/DB blip right
//    between those two events. Re-invoking dispatch (as
//    retryFailedSettlements would on its next sweep) must not
//    double-dispatch on-chain, and must reach a correct terminal state
//    via the existing DecisionAlreadySettledError reconciliation path.
// 2. a real transient Prisma error (P1001-style) on
//    dispatchSettlementForDecision's own write path, verifying
//    withDbRetry actually recovers it end-to-end (not just in
//    isolation, as db-retry.test.ts already covers) with no lost
//    decision and no double dispatch.
// 3. "signer unavailable" quorum states, instrumented via
//    SignerLifecycleEvent rows: insufficient EVM attestor signatures
//    persists a SIGNING event (pending-quorum, not a silent failure or
//    thrown error out of dispatch), while a normal single-attempt
//    success never leaves a stuck SIGNING row behind.

const dispatchDecisionForCase = vi.fn();

vi.mock("@/lib/hyperlane", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hyperlane")>("@/lib/hyperlane");
  return {
    ...actual,
    dispatchDecisionForCase: (...args: unknown[]) => dispatchDecisionForCase(...args),
  };
});

const { dispatchSettlementForDecision } = await import("@/lib/adjudication-service");
const { DecisionAlreadySettledError, InsufficientAttestorSignaturesError } = await import("@/lib/hyperlane");

let orgId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "settlement-resilience-test-org" } });
  orgId = org.id;
});

beforeEach(() => {
  dispatchDecisionForCase.mockReset();
});

afterAll(async () => {
  const decisionIds = (await prisma.decision.findMany({ where: { case: { organizationId: orgId } }, select: { id: true } })).map((d) => d.id);
  await prisma.signerLifecycleEvent.deleteMany({ where: { decisionId: { in: decisionIds } } });
  await prisma.decision.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

async function makeFinalizedDecision() {
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
      decisionHash: "c".repeat(64),
    },
  });
  return { kase, decision };
}

describe("worker crash between on-chain dispatch and the DB write that records it", () => {
  it("does not double-dispatch on-chain; recovers via DecisionAlreadySettledError reconciliation on the next attempt", async () => {
    const { kase, decision } = await makeFinalizedDecision();

    dispatchDecisionForCase
      .mockImplementationOnce(async () => ({ txHash: "0xrealtx", messageId: "0xmsg" }))
      .mockImplementationOnce(async () => {
        throw new DecisionAlreadySettledError(decision.decisionHash!);
      });

    // Not a transient-error code: withDbRetry only retries the narrow
    // transient set, so this simulates the write failing hard (or the
    // process itself dying mid-write) — the case that genuinely leaves
    // relayTxHash unpersisted despite the on-chain call having landed.
    const updateSpy = vi.spyOn(prisma.decision, "update");
    updateSpy.mockImplementationOnce(() => {
      throw new Error("simulated crash: process died before write landed");
    });

    // First attempt: on-chain call "really" succeeds (mock #1), but the
    // very next persistence write is simulated as never landing — same
    // failure shape as the live 2026-09-07 incident, just on the
    // post-dispatch write instead of the decision-creation write.
    await dispatchSettlementForDecision(kase, decision);
    updateSpy.mockRestore();

    let reloaded = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    // The crash means relayTxHash was never durably recorded locally —
    // this is the exact state a real process crash would leave behind.
    expect(reloaded.relayTxHash).toBeNull();
    expect(reloaded.relayError).toBeTruthy();

    // Re-invoke the same dispatch path on the same decision "from
    // scratch" (as retryFailedSettlements' periodic sweep would on its
    // next tick — called directly here, rather than through the global
    // sweep, since the sweep also picks up unrelated stuck decisions
    // left in this shared test DB by other suites; see vitest.config.ts's
    // own note on why file-level isolation isn't guaranteed here). The
    // real chain state already reflects the first (successful) dispatch,
    // so this second dispatchDecisionForCase call must be rejected as
    // already-settled — proving no double-spend is possible even though
    // this process has no local memory of the first attempt having gone
    // through.
    // The first attempt's relayClaimedAt lease is still technically held
    // (it was set successfully before the simulated crash) — a real
    // retry sweep only revisits this decision once RELAY_CLAIM_TTL_MS
    // has elapsed, treating an expired lease as an abandoned attempt.
    // Simulate that elapsed time directly rather than waiting 5 real
    // minutes.
    reloaded = await prisma.decision.update({
      where: { id: decision.id },
      data: { relayClaimedAt: new Date(Date.now() - 10 * 60 * 1000) },
    });
    await dispatchSettlementForDecision(kase, reloaded);
    expect(dispatchDecisionForCase).toHaveBeenCalledTimes(2);

    reloaded = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(reloaded.relayTxHash).toBe("reconciled:onchain");
    expect(reloaded.relayError).toBeNull();

    const events = await prisma.signerLifecycleEvent.findMany({ where: { decisionId: decision.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.state)).toContain("FAILED");
  });
});

describe("transient DB failure on dispatchSettlementForDecision's own write path", () => {
  it("recovers via withDbRetry with no lost decision and exactly one on-chain dispatch", async () => {
    const { kase, decision } = await makeFinalizedDecision();
    dispatchDecisionForCase.mockResolvedValue({ txHash: "0xrecoveredtx", messageId: "0xmsg2" });

    const originalUpdate = prisma.decision.update.bind(prisma.decision);
    const updateSpy = vi.spyOn(prisma.decision, "update");
    let transientThrown = false;
    updateSpy.mockImplementation((...args: Parameters<typeof prisma.decision.update>) => {
      const [arg] = args;
      const isRelayTxWrite = typeof arg === "object" && arg !== null && "data" in arg && (arg as { data?: { relayTxHash?: unknown } }).data?.relayTxHash === "0xrecoveredtx";
      if (isRelayTxWrite && !transientThrown) {
        transientThrown = true;
        throw Object.assign(new Error("transient: P1001"), { code: "P1001" });
      }
      return originalUpdate(...args);
    });

    await dispatchSettlementForDecision(kase, decision);
    updateSpy.mockRestore();

    expect(transientThrown).toBe(true);
    expect(dispatchDecisionForCase).toHaveBeenCalledTimes(1);

    const reloaded = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(reloaded.relayTxHash).toBe("0xrecoveredtx");
    expect(reloaded.relayError).toBeNull();
  });
});

describe("signer unavailable — quorum pending vs. quorum reached", () => {
  it("persists a SIGNING (pending-quorum) event, never a silent failure or thrown error, when attestor signatures are insufficient", async () => {
    const { kase, decision } = await makeFinalizedDecision();
    dispatchDecisionForCase.mockRejectedValue(new InsufficientAttestorSignaturesError("0xhash" as `0x${string}`, 1, 2));

    await expect(dispatchSettlementForDecision(kase, decision)).resolves.toBeUndefined();

    const reloaded = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(reloaded.relayTxHash).toBeNull();
    expect(reloaded.relayAttempts).toBe(0); // not counted as a real failed attempt — see adjudication-service's own comment
    expect(reloaded.pendingAttestationHash).toBe("0xhash");

    const events = await prisma.signerLifecycleEvent.findMany({ where: { decisionId: decision.id } });
    expect(events).toHaveLength(1);
    expect(events[0].state).toBe("SIGNING");
    expect(events[0].reason).toContain("1/2");
  });

  it("reaches quorum and settles normally when only one signer is briefly unavailable but a 2-of-3 threshold is otherwise met", async () => {
    const { kase, decision } = await makeFinalizedDecision();
    // Modeled as: the combined available signatures already meet
    // threshold, so dispatchDecisionForCase succeeds on the first call —
    // one signer being unavailable never blocked quorum in the first
    // place. Distinguishes this from the previous test's 2-of-3-unavailable
    // case, where quorum is NOT met and dispatch must instead land in the
    // pending SIGNING state above rather than either settling or throwing.
    dispatchDecisionForCase.mockResolvedValue({ txHash: "0xquorumtx", messageId: "0xmsg3" });

    await dispatchSettlementForDecision(kase, decision);

    const reloaded = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(reloaded.relayTxHash).toBe("0xquorumtx");

    const events = await prisma.signerLifecycleEvent.findMany({ where: { decisionId: decision.id } });
    expect(events.some((e) => e.state === "SIGNING")).toBe(false);
    expect(events.some((e) => e.state === "SETTLED")).toBe(true);
  });
});
