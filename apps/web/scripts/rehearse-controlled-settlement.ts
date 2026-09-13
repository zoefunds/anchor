// Constrained, single-case, single-use automation rehearsal (2026-09-13
// remediation plan, item 3). Unlike scripts/e2e-sepolia-attested-settle.ts
// and scripts/e2e-sepolia-full-genlayer-to-payout.ts (which call
// attestedSettle() directly, reimplementing the payload/signing steps
// to isolate the payout mechanism itself), THIS script calls the real
// production function — dispatchSettlementForDecision, exactly as
// retryFailedSettlements/finalizeExpiredAppealWindows/runAdjudicationJob
// call it — so it proves the actual worker/application path: canonical
// payload construction, the real 2-of-3 attestation flow (including
// waiting on the real external attestor service via the real
// pendingAttestationHash/pendingAttestationSignatures + POST
// /api/internal/pending-attestations/[id]/sign route), and the real
// attestedSettle() submission code, with every pre-dispatch invariant
// dispatchSettlementForDecision already enforces (consensus, no double
// dispatch, relay-attempt cap, settlement limit, risk/velocity/human-review
// gates, atomic claim/lease).
//
// SETTLEMENT_PAUSED is NEVER lifted by this script or by
// dispatchSettlementForDecision's new bypass — the bypass only applies
// to the ONE decision whose own testRehearsalAuthToken matches a token
// this script itself generated and explicitly supplied, and is consumed
// (can never be reused) the moment a real dispatch actually succeeds.
// See adjudication-service.ts's dispatchSettlementForDecision for the
// exact mechanism.
//
// Usage:
//   npx tsx scripts/rehearse-controlled-settlement.ts --authorize <caseId>
//     -> generates and stores a fresh one-time token for that case's
//        latest decision, prints it. Requires the case to already be
//        FINALIZED with an ACCEPTED decision (e.g. via a real
//        runAdjudicationJob run) and not yet settled.
//   npx tsx scripts/rehearse-controlled-settlement.ts --run <caseId> <token>
//     -> consumes that authorization to run ONE real dispatch for that
//        one decision only, waits for the real external attestor
//        signature, verifies the payout, attempts a replay (must fail),
//        and confirms SETTLEMENT_PAUSED is still true throughout.
import { randomBytes } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { createPublicClient, http, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { prisma } from "../src/lib/prisma";
import { dispatchSettlementForDecision, isSettlementPaused } from "../src/lib/adjudication-service";
import { ACTIVE_SEPOLIA_TOPOLOGY } from "../src/lib/deployment-registry";

const RPC_URL = process.env.HYPERLANE_RELAY_RPC_URL ?? "https://ethereum-sepolia.publicnode.com";
const POLL_INTERVAL_MS = 15_000;
// Must exceed adjudication-service.ts's own RELAY_CLAIM_TTL_MS (5 min):
// the real dispatchSettlementForDecision sets an atomic claim/lease on
// its FIRST attempt (before it can know whether signatures are
// sufficient) and does not release it early on an
// InsufficientAttestorSignaturesError — by design, so a concurrent
// worker can't also attempt the same decision. A retry within that
// window correctly no-ops ("already has an in-flight relay claim"),
// exactly matching retryFailedSettlements' own real production cadence.
const POLL_TIMEOUT_MS = 420_000;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function authorize(caseId: string) {
  const decision = await prisma.decision.findFirstOrThrow({ where: { caseId }, orderBy: { createdAt: "desc" } });
  const kase = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });

  if (kase.status !== "FINALIZED") throw new Error(`case ${caseId} is ${kase.status}, not FINALIZED — refusing to authorize`);
  if (decision.consensus !== "ACCEPTED") throw new Error(`decision ${decision.id} consensus is ${decision.consensus}, not ACCEPTED`);
  if (decision.relayTxHash) throw new Error(`decision ${decision.id} already has relayTxHash ${decision.relayTxHash} — already settled, nothing to rehearse`);
  if (decision.testRehearsalAuthToken && !decision.testRehearsalConsumedAt) {
    throw new Error(`decision ${decision.id} already has an unconsumed rehearsal token — use it or wait for it to be consumed before authorizing again`);
  }

  const token = randomBytes(32).toString("hex");
  await prisma.decision.update({ where: { id: decision.id }, data: { testRehearsalAuthToken: token, testRehearsalConsumedAt: null } });
  console.log(`Authorized decision ${decision.id} (case ${caseId}) for exactly one rehearsal dispatch.`);
  console.log(`Token (single-use, save it): ${token}`);
  console.log(`Run: npx tsx scripts/rehearse-controlled-settlement.ts --run ${caseId} ${token}`);
}

async function run(caseId: string, token: string) {
  if (!isSettlementPaused()) {
    throw new Error(
      "SETTLEMENT_PAUSED is not set in this process's environment. This rehearsal is only meaningful as proof that the " +
        "real worker path correctly stays gated for every OTHER case while this one, explicitly authorized decision " +
        "proceeds — run with SETTLEMENT_PAUSED=true set (matching the real production worker's actual configuration)."
    );
  }

  const outDir = path.resolve(__dirname, "../../../artifacts/submission/sepolia-controlled-rehearsal");
  mkdirSync(outDir, { recursive: true });

  let kase = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
  let decision = await prisma.decision.findFirstOrThrow({ where: { caseId }, orderBy: { createdAt: "desc" } });
  if (decision.testRehearsalAuthToken !== token) throw new Error(`token does not match decision ${decision.id}'s stored authorization`);
  if (decision.testRehearsalConsumedAt) throw new Error(`decision ${decision.id}'s rehearsal authorization was already consumed at ${decision.testRehearsalConsumedAt.toISOString()} — run --authorize again for a fresh one`);
  if (decision.relayTxHash) throw new Error(`decision ${decision.id} already has relayTxHash ${decision.relayTxHash}`);

  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
  const t = ACTIVE_SEPOLIA_TOPOLOGY;
  const caseSettlement = await prisma.caseSettlement.findUniqueOrThrow({ where: { caseId } });

  console.log(`[rehearsal] SETTLEMENT_PAUSED confirmed set. Dispatching decision ${decision.id} (case ${caseId}) via the REAL dispatchSettlementForDecision, authorized for this one decision only.`);

  const ESCROW_ABI = [{ type: "function", name: "deposits", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ name: "status", type: "uint8" }, { name: "claimant", type: "address" }, { name: "respondent", type: "address" }, { name: "amount", type: "uint256" }, { name: "caseId", type: "bytes32" }, { name: "depositedAt", type: "uint256" }] }] as const;
  const respondentAddress = caseSettlement.respondentAddress as `0x${string}`;
  const respondentBalanceBefore = await publicClient.getBalance({ address: respondentAddress });

  const waitUntil = Date.now() + POLL_TIMEOUT_MS;
  let settled = false;
  while (Date.now() < waitUntil) {
    await dispatchSettlementForDecision(kase, decision, token);
    decision = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    if (decision.relayTxHash) {
      settled = true;
      break;
    }
    console.log(`[rehearsal]   not yet settled — relayError=${decision.relayError}, pendingAttestationSignatures=${decision.pendingAttestationSignatures.length}/${t.attestorThreshold}. Waiting on the real external attestor service...`);
    await sleep(POLL_INTERVAL_MS);
  }
  if (!settled) throw new Error(`decision ${decision.id} did not settle within ${POLL_TIMEOUT_MS / 1000}s — last relayError: ${decision.relayError}`);

  console.log(`[rehearsal] real dispatch succeeded: relayTxHash=${decision.relayTxHash}`);

  if (!isSettlementPaused()) throw new Error("SETTLEMENT_PAUSED became false during this rehearsal — this must never happen");
  const globalPauseHeld = isSettlementPaused();

  const refreshedDecision = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
  if (!refreshedDecision.testRehearsalConsumedAt) throw new Error("rehearsal token was NOT consumed after a successful dispatch — re-arm logic is broken");
  console.log(`[rehearsal] authorization consumed at ${refreshedDecision.testRehearsalConsumedAt.toISOString()} — cannot be reused.`);

  // Verify escrow state + exact payout.
  const escrowId = caseSettlement.escrowId as Hex;
  const escrowState = await publicClient.readContract({ address: t.escrow, abi: ESCROW_ABI, functionName: "deposits", args: [escrowId] });
  if (Number(escrowState[0]) !== 2) throw new Error(`escrow status ${escrowState[0]}, expected 2 (SETTLED)`);
  const respondentBalanceAfter = await publicClient.getBalance({ address: respondentAddress });
  const respondentDelta = respondentBalanceAfter - respondentBalanceBefore;
  const totalAtto = BigInt(caseSettlement.expectedAmountAtto);
  const respondentBps = BigInt(decision.respondentShareBps ?? 0);
  const expectedRespondentDelta = (totalAtto * respondentBps) / 10000n;
  console.log(`[rehearsal] respondent balance delta: ${respondentDelta} (expected ${expectedRespondentDelta})`);
  if (respondentDelta !== expectedRespondentDelta) throw new Error(`payout mismatch: got ${respondentDelta}, expected ${expectedRespondentDelta}`);

  // Replay: re-authorizing is impossible (token consumed), but the
  // real code path's own idempotency must ALSO independently refuse —
  // calling dispatchSettlementForDecision again (even with the
  // now-consumed token) must be a safe no-op, not a second on-chain call.
  let replayOutcome: string;
  try {
    await dispatchSettlementForDecision(kase, refreshedDecision, token);
    const afterReplay = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    replayOutcome = afterReplay.relayTxHash === refreshedDecision.relayTxHash ? "no-op (relayTxHash unchanged — early-return guard held)" : "UNEXPECTED: relayTxHash changed on replay";
    if (afterReplay.relayTxHash !== refreshedDecision.relayTxHash) throw new Error(replayOutcome);
  } catch (err) {
    replayOutcome = `threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  console.log(`[rehearsal] replay of dispatchSettlementForDecision: ${replayOutcome}`);

  const write = (name: string, data: unknown) => writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2) + "\n");
  write("rehearsal.json", {
    chain: "sepolia",
    caseId,
    decisionId: decision.id,
    settlementPausedThroughout: globalPauseHeld,
    dispatchFunction: "adjudication-service.ts#dispatchSettlementForDecision (real production code, unmodified call sites for every other caller)",
    relayTxHash: decision.relayTxHash,
    relayMessageId: decision.relayMessageId,
    respondentAddress,
    respondentBalanceBeforeWei: respondentBalanceBefore.toString(),
    respondentBalanceAfterWei: respondentBalanceAfter.toString(),
    respondentDeltaWei: respondentDelta.toString(),
    expectedRespondentDeltaWei: expectedRespondentDelta.toString(),
    match: respondentDelta === expectedRespondentDelta,
    rehearsalTokenConsumedAt: refreshedDecision.testRehearsalConsumedAt,
    replayOutcome,
    timestamp: new Date().toISOString(),
  });

  console.log(`\n[rehearsal] SUCCESS — real worker path proven for one authorized case, global SETTLEMENT_PAUSED held throughout. Bundle at ${outDir}`);
}

async function main() {
  const [, , mode, ...args] = process.argv;
  if (mode === "--authorize" && args[0]) {
    await authorize(args[0]);
  } else if (mode === "--run" && args[0] && args[1]) {
    await run(args[0], args[1]);
  } else {
    console.error("Usage:\n  --authorize <caseId>\n  --run <caseId> <token>");
    process.exit(1);
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[rehearsal] FAILED:", err);
  await prisma.$disconnect();
  process.exit(1);
});
