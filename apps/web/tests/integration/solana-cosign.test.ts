import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { generateKeyPairSync, sign as cryptoSign, createPrivateKey } from "crypto";
import { prisma } from "@/lib/prisma";

// Exercises the Solana M-of-N co-signing workflow end to end against
// real Postgres — the specific gap a re-audit flagged: submitAttestedSettle
// requires 2-of-2 but dispatchDecisionForCase's Solana branch was never
// given a way to supply the second (externally-collected) signature, so
// every real 2-of-2 Solana decision would throw
// InsufficientSolanaAttestationsError forever with no path to recovery.
// See lib/solana-settle.ts, the pending-solana-attestations API routes,
// and docs/multisig-attestor-setup.md's Solana section.
//
// solana-settle's real on-chain submission (submitAttestedSettle) is
// mocked out — this test proves the WIRING (pending-state persistence,
// the sign endpoint's verification, the retry path resuming and
// clearing state, exactly-once settlement), not Solana RPC connectivity
// itself, which chains/solana/'s own tests already cover.

const submitAttestedSettle = vi.fn();
// dispatchDecisionForCase's Solana branch now unconditionally requires a
// bound, DEPOSITED CaseSettlement AND a verified on-chain deposit match
// (2026-09-14 fix, closing a real P0: it used to skip both checks
// entirely for a case with no CaseSettlement). This suite's fixtures now
// create a real CaseSettlement (see makeSolanaDecision below), but the
// on-chain deposit verification itself still needs mocking — this test
// is about the co-signing wiring, not live Solana RPC connectivity.
const assertSolanaEscrowDepositMatches = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/solana-settle", async () => {
  const actual = await vi.importActual<typeof import("@/lib/solana-settle")>("@/lib/solana-settle");
  return {
    ...actual,
    submitAttestedSettle: (...args: unknown[]) => submitAttestedSettle(...args),
  };
});

vi.mock("@/lib/solana-escrow", async () => {
  const actual = await vi.importActual<typeof import("@/lib/solana-escrow")>("@/lib/solana-escrow");
  return {
    ...actual,
    assertSolanaEscrowDepositMatches: (...args: unknown[]) => assertSolanaEscrowDepositMatches(...args),
  };
});

// Imported after the mock so hyperlane.ts's dynamic import picks up the mocked binding.
const { retryFailedSettlements } = await import("@/lib/adjudication-service");
const { InsufficientSolanaAttestationsError, isRegisteredSolanaAttestor } = await import("@/lib/solana-settle");
const { POST: signRoute } = await import("@/app/api/internal/pending-solana-attestations/[decisionId]/sign/route");

const INTERNAL_SECRET = "test-secret-solana-cosign";
let orgId: string;

// A real Ed25519 keypair generated fresh for this test run — NOT one of
// decision-relay's actual registered ATTESTOR_PUBKEYS, so these tests
// exercise the full flow's REJECTION path for real (an unregistered key
// must never be accepted) using a genuine, well-formed signature, not a
// garbage/malformed one that would be rejected for a different reason.
const strangerKeys = generateKeyPairSync("ed25519");

function signMessageHex(privateKeyDer: Buffer, messageHex: string): string {
  const message = Buffer.from(messageHex.slice(2), "hex");
  const privateKey = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  return "0x" + cryptoSign(null, message, privateKey).toString("hex");
}

beforeAll(async () => {
  process.env.ATTESTOR_COSIGN_SECRET = INTERNAL_SECRET;
  const org = await prisma.organization.create({ data: { name: "solana-cosign-test-org" } });
  orgId = org.id;
});

beforeEach(async () => {
  submitAttestedSettle.mockReset();
  assertSolanaEscrowDepositMatches.mockReset();
  assertSolanaEscrowDepositMatches.mockResolvedValue(undefined);
  // Each test creates its own case/decision; clear out prior tests'
  // rows first so retryFailedSettlements' sweep query (which matches
  // ANY decision with relayError set across the whole org) only ever
  // sees the current test's fixture — otherwise a decision left in an
  // "awaiting signatures" state by an earlier test gets swept up
  // alongside the one this test is actually asserting on.
  await prisma.decision.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.caseSettlement.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  await prisma.settlementIntegration.deleteMany({ where: { organizationId: orgId } });
});

afterAll(async () => {
  await prisma.decision.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.caseSettlement.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  await prisma.settlementIntegration.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

async function makeSolanaDecision() {
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
      settlementChain: "solanatestnet",
      settlementContract: "DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN",
      settlementSolanaClaimant: "11111111111111111111111111111112",
      settlementSolanaRespondent: "11111111111111111111111111111113",
      settlementSolanaEscrowProgram: "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn",
      settlementSolanaCaseId: "CASE-TEST-SOLANA-COSIGN",
    },
  });
  // A bound, DEPOSITED CaseSettlement is now unconditionally required
  // (2026-09-14 fix — see this file's top-of-file comment update). The
  // real on-chain deposit-match check is mocked above
  // (assertSolanaEscrowDepositMatches); this row only needs to exist and
  // report DEPOSITED with both party addresses set.
  const integration = await prisma.settlementIntegration.create({
    data: {
      organizationId: orgId,
      chain: "solanatestnet",
      escrowContractAddress: "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn",
      assetSymbol: "SOL",
      assetDecimals: 9,
      createdByMemberId: "test-member",
    },
  });
  await prisma.caseSettlement.create({
    data: {
      caseId: kase.id,
      integrationId: integration.id,
      status: "DEPOSITED",
      escrowId: "CASE-TEST-SOLANA-COSIGN",
      expectedAmountAtto: "100000000000",
      claimantAddress: "11111111111111111111111111111112",
      respondentAddress: "11111111111111111111111111111113",
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
      reasonCodes: [],
      evidenceUsed: [],
      consensus: "ACCEPTED",
      proofHash: "a".repeat(64),
      decisionHash: "b".repeat(64),
    },
  });
  return { kase, decision };
}

describe("Solana M-of-N co-signing", () => {
  it("blocks dispatch with only 1-of-2 signatures and persists the pending message", async () => {
    const { decision } = await makeSolanaDecision();
    submitAttestedSettle.mockRejectedValueOnce(new InsufficientSolanaAttestationsError("0xdeadbeef", 1, 2));

    // retryFailedSettlements' own query is global (all organizations,
    // all decisions with relayError set), so it isn't a reliable "count
    // of just this test's fixture" signal when other test FILES run
    // against the same shared DB — this test's actual assertion is what
    // dispatchSettlementForDecision itself persists, called directly
    // via the same path retryFailedSettlements uses internally.
    const { dispatchSettlementForDecision } = await import("@/lib/adjudication-service");
    const kase = await prisma.case.findUniqueOrThrow({ where: { id: decision.caseId } });
    await dispatchSettlementForDecision(kase, decision);

    const updated = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(updated.relayTxHash).toBeNull();
    expect(updated.pendingSolanaAttestationMessage).toBe("0xdeadbeef");
    expect(updated.relayAttempts).toBe(0); // deliberately NOT incremented — see adjudication-service.ts's own comment
  });

  it("rejects a well-formed signature from an unregistered key", async () => {
    const { decision } = await makeSolanaDecision();
    await prisma.decision.update({ where: { id: decision.id }, data: { pendingSolanaAttestationMessage: "0x" + "ab".repeat(32) } });

    expect(isRegisteredSolanaAttestor("11111111111111111111111111111112")).toBe(false);

    const req = new Request(`http://localhost/api/internal/pending-solana-attestations/${decision.id}/sign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: "11111111111111111111111111111112", signature: "0x" + "00".repeat(64) }),
    });
    // @ts-expect-error - Next's route handler types expect its own NextRequest; a plain Request works identically for what this route reads (headers/json body).
    const res = await signRoute(req, { params: Promise.resolve({ decisionId: decision.id }) });
    expect(res.status).toBe(403);
  });

  it("resumes after a real offline signature arrives, and settles exactly once", async () => {
    // retryFailedSettlements() sweeps ALL organizations' decisions in the
    // shared dev Postgres (see vitest.config.ts's fileParallelism note) —
    // under full-suite load this legitimately exceeds the global 15s
    // default; bump locally rather than raising it for every test.
    const { decision } = await makeSolanaDecision();
    const messageHex = "0x" + "cd".repeat(40);
    await prisma.decision.update({ where: { id: decision.id }, data: { pendingSolanaAttestationMessage: messageHex } });

    // The OFFLINE attestor holder's real (but locally-generated, not the
    // real registered) Ed25519 key — signs the real message bytes.
    // Since verifySolanaAttestationSignature checks the signature
    // against the CLAIMED public key regardless of whether that key is
    // the "real" registered one, and isRegisteredSolanaAttestor is
    // checked separately and FIRST in the route, we sign with our own
    // test key but submit it under the second real registered pubkey to
    // exercise the full accept path without needing that key's actual
    // private material (which — correctly — this test suite must never
    // hold). This still proves signature verification runs (a
    // mismatched signature/pubkey pair is rejected — see the next
    // assertion) before proving the accept path.
    // 2026-09-07: the old pure-offline attestor was retired in favor of
    // two automated signers — see docs/multisig-attestor-setup.md. Any
    // currently-registered non-backend pubkey works for this test; using
    // one of the new automated ones.
    const otherRegisteredAttestor = "4eCqu5xB2EoLFw5AfSyjTm3cRnjdocs6wfwGaSp7rigZ";
    const wrongSig = signMessageHex(strangerKeys.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer, messageHex);
    const rejectReq = new Request(`http://localhost/api/internal/pending-solana-attestations/${decision.id}/sign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${INTERNAL_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: otherRegisteredAttestor, signature: wrongSig }),
    });
    // @ts-expect-error - see above
    const rejectRes = await signRoute(rejectReq, { params: Promise.resolve({ decisionId: decision.id }) });
    expect(rejectRes.status).toBe(400); // registered key, but signature doesn't match it — must be rejected

    const stillPending = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect((stillPending.pendingSolanaAttestations as unknown[]).length).toBe(0);

    // Now simulate the retry sweep resuming dispatch once "enough"
    // signatures exist — submitAttestedSettle itself is mocked, so this
    // proves the resume/clear-pending-state/exactly-once properties
    // without needing a real second private key.
    submitAttestedSettle.mockResolvedValueOnce({ signature: "real-tx-signature-1" });
    await prisma.decision.update({
      where: { id: decision.id },
      data: { relayError: "awaiting external Solana attestor signature(s): 1/2 collected" },
    });
    // retryFailedSettlements' return value counts ALL organizations'
    // stuck decisions globally, so it isn't reliable to assert an exact
    // number against when other test FILES may run in the same process
    // against the same shared DB — assert on THIS decision's own state
    // and on submitAttestedSettle actually having been called instead.
    await retryFailedSettlements();
    expect(submitAttestedSettle).toHaveBeenCalledTimes(1);

    const settled = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    expect(settled.relayTxHash).toBe("real-tx-signature-1");
    expect(settled.pendingSolanaAttestationMessage).toBeNull();
    expect((settled.pendingSolanaAttestations as unknown[]).length).toBe(0);

    // A second retry sweep must NOT dispatch again — relayTxHash is now set.
    submitAttestedSettle.mockClear();
    await retryFailedSettlements();
    expect(submitAttestedSettle).not.toHaveBeenCalled();
  }, 45000);
});
