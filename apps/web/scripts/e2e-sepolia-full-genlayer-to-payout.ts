// Full-chain proof (2026-09-13, follow-up to scripts/e2e-sepolia-attested-settle.ts):
// real GenLayer adjudication -> real appeal-finalized decision -> real
// attestedSettle() payout on Sepolia. Unlike that earlier script, this
// one does NOT fabricate a Decision row — it calls the REAL production
// adjudication code path (runAdjudicationJob, the exact function the
// app itself calls) twice (initial decision, then an appeal to reach
// FINALIZED immediately rather than waiting out a real appeal window),
// so the GenLayer contract deploy, evidence submission, and consensus
// are all genuine.
//
// dispatchSettlementForDecision (called internally by runAdjudicationJob
// once FINALIZED) is expected to be BLOCKED by SETTLEMENT_PAUSED, which
// stays set throughout — this script does not lift it, per the standing
// incident-recovery constraint that the pause is a global gate affecting
// every case, not something to touch for one rehearsal. Instead, once
// the real decision is confirmed FINALIZED with a real
// decisionHash/proofHash, this script performs the SAME direct
// attestedSettle() call scripts/e2e-sepolia-attested-settle.ts already
// proved works — using the real values GenLayer actually produced, not
// synthetic ones.
//
// Run: npx tsx scripts/e2e-sepolia-full-genlayer-to-payout.ts
// Writes a JSON proof bundle to artifacts/submission/sepolia-full-chain/.
import { createPublicClient, createWalletClient, http, type Address, type Hex, keccak256, encodePacked, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { mkdirSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import { computeDirectSettleAttestationHash, submitAttestedSettle, caseIdToBytes32 } from "@anchor/hyperlane-relay";
import { ACTIVE_SEPOLIA_TOPOLOGY } from "../src/lib/deployment-registry";
import { prisma } from "../src/lib/prisma";
import { runAdjudicationJob, isSettlementPaused, SETTLEMENT_BLOCKED_PAUSED } from "../src/lib/adjudication-service";

const RPC_URL = process.env.HYPERLANE_RELAY_RPC_URL ?? "https://ethereum-sepolia.publicnode.com";
const DISPATCH_PRIVATE_KEY = (process.env.HYPERLANE_RELAY_PRIVATE_KEY ?? "").trim();
if (!DISPATCH_PRIVATE_KEY) throw new Error("HYPERLANE_RELAY_PRIVATE_KEY is required");
const dispatchKey = (DISPATCH_PRIVATE_KEY.startsWith("0x") ? DISPATCH_PRIVATE_KEY : `0x${DISPATCH_PRIVATE_KEY}`) as Hex;

const ATTESTOR_PRIVATE_KEY = (process.env.ATTESTOR_PRIVATE_KEYS ?? process.env.ATTESTOR_PRIVATE_KEY ?? "").split(",")[0]?.trim();
if (!ATTESTOR_PRIVATE_KEY) throw new Error("ATTESTOR_PRIVATE_KEYS (or ATTESTOR_PRIVATE_KEY) is required");
const attestorKey = (ATTESTOR_PRIVATE_KEY.startsWith("0x") ? ATTESTOR_PRIVATE_KEY : `0x${ATTESTOR_PRIVATE_KEY}`) as Hex;

const DEPOSIT_AMOUNT_WEI = 200_000_000_000_000n; // 0.0002 ETH — small, fixed rehearsal amount
const RESPONDENT_ADDRESS = getAddress("0x000000000000000000000000000000000000b0b0");
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 180_000;

const ESCROW_ABI = [
  { type: "function", name: "authorizeDeposit", stateMutability: "nonpayable", inputs: [{ name: "caseId", type: "bytes32" }, { name: "escrowId", type: "bytes32" }, { name: "claimant", type: "address" }, { name: "respondent", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [{ name: "caseId", type: "bytes32" }, { name: "escrowId", type: "bytes32" }, { name: "claimant", type: "address" }, { name: "respondent", type: "address" }], outputs: [] },
  { type: "function", name: "deposits", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ name: "status", type: "uint8" }, { name: "claimant", type: "address" }, { name: "respondent", type: "address" }, { name: "amount", type: "uint256" }, { name: "caseId", type: "bytes32" }, { name: "depositedAt", type: "uint256" }] },
] as const;

const DECISION_RELAY_ABI = [
  { type: "function", name: "processedDecisions", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

function nowIso() {
  return new Date().toISOString();
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!isSettlementPaused()) {
    throw new Error(
      "SETTLEMENT_PAUSED is not set in this process's environment — refusing to run. " +
        "This script deliberately calls the real runAdjudicationJob, whose internal " +
        "dispatchSettlementForDecision must be blocked by the pause; if it isn't, this " +
        "script would trigger a REAL automated dispatch attempt outside the reviewed, " +
        "manual flow it's meant to demonstrate."
    );
  }

  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
  const dispatchAccount = privateKeyToAccount(dispatchKey);
  const walletClient = createWalletClient({ chain: sepolia, transport: http(RPC_URL), account: dispatchAccount });
  const attestorAccount = privateKeyToAccount(attestorKey);
  const claimant = dispatchAccount.address;
  const t = ACTIVE_SEPOLIA_TOPOLOGY;
  const outDir = path.resolve(__dirname, "../../../artifacts/submission/sepolia-full-chain");
  mkdirSync(outDir, { recursive: true });

  console.log(`[full-chain] SETTLEMENT_PAUSED confirmed set — dispatchSettlementForDecision will be blocked as expected; settlement below is a separate, manual, direct call.`);
  console.log(`[full-chain] DecisionRelay: ${t.decisionRelay}, Escrow: ${t.escrow}`);

  // 1. Real org/integration/case, with real evidence for policy agent_data_task_v1.
  let org = await prisma.organization.findFirst({ where: { name: "e2e-full-genlayer-to-payout" } });
  if (!org) org = await prisma.organization.create({ data: { name: "e2e-full-genlayer-to-payout" } });

  let integration = await prisma.settlementIntegration.findFirst({ where: { organizationId: org.id, chain: "sepolia", escrowContractAddress: t.escrow, active: true } });
  if (!integration) {
    integration = await prisma.settlementIntegration.create({
      data: { organizationId: org.id, chain: "sepolia", escrowContractAddress: t.escrow, assetSymbol: "ETH", assetDecimals: 18, escrowVersion: "V2", createdByMemberId: "e2e-script" },
    });
  }

  const kase = await prisma.case.create({
    data: {
      organizationId: org.id,
      claim: "Agent B delivered the requested dataset exactly per spec; Agent A disputes anyway (rehearsal fixture, clear-cut RELEASE_FULL).",
      amount: "0.0002",
      currency: "ETH",
      policyId: "agent_data_task_v1",
      policyVersion: "1.0.0",
      claimantRef: "e2e-claimant",
      respondentRef: "e2e-respondent",
      settlementChain: "sepolia",
      settlementContract: t.decisionRelay,
      status: "EVIDENCE_COLLECTION",
    },
  });
  console.log(`[full-chain] case: ${kase.id}`);

  // Real evidence, designed to make a clear-cut RELEASE_FULL outcome
  // unambiguous for the real GenLayer adjudicator contract.
  const evidenceRows: { type: string; submittedBy: "claimant" | "respondent"; storageRef: string }[] = [
    { type: "task_spec", submittedBy: "claimant", storageRef: "Deliver a CSV of the top 50 US cities by population, columns: city, state, population. Deadline: 2026-09-20." },
    { type: "delivery_payload", submittedBy: "respondent", storageRef: "Delivered top50_us_cities.csv on 2026-09-14 containing exactly city, state, population columns for the 50 most populous US cities, verified against 2026 Census estimates." },
    { type: "claimant_statement", submittedBy: "claimant", storageRef: "The file arrived and the schema matches what we asked for; we're only disputing on principle over an unrelated pricing disagreement, not the delivery itself." },
    { type: "respondent_statement", submittedBy: "respondent", storageRef: "We delivered exactly the spec'd file on time with correct data and schema. We request release of the escrowed payment in full." },
  ];
  await prisma.evidence.createMany({
    data: evidenceRows.map((e) => ({ caseId: kase.id, type: e.type, submittedBy: e.submittedBy, storageRef: e.storageRef, contentHash: createHash("sha256").update(e.storageRef).digest("hex") })),
  });
  console.log(`[full-chain] evidence submitted (4 items)`);

  // 2. Real on-chain deposit (same mechanics as scripts/e2e-sepolia-attested-settle.ts).
  const caseIdBytes32 = caseIdToBytes32(kase.id);
  const escrowIdSeed = `${kase.id}:${Date.now()}`;
  const escrowId = keccak256(encodePacked(["string"], [escrowIdSeed]));

  const caseSettlement = await prisma.caseSettlement.create({
    data: {
      caseId: kase.id,
      integrationId: integration.id,
      escrowId,
      claimantAddress: claimant,
      claimantAddressSetAt: new Date(),
      respondentAddress: RESPONDENT_ADDRESS,
      respondentAddressSetAt: new Date(),
      expectedAmountAtto: DEPOSIT_AMOUNT_WEI.toString(),
      status: "PENDING_DEPOSIT",
    },
  });

  console.log(`[full-chain] authorizing + depositing on-chain...`);
  const authTxHash = await walletClient.writeContract({ address: t.escrow, abi: ESCROW_ABI, functionName: "authorizeDeposit", args: [caseIdBytes32, escrowId, claimant, RESPONDENT_ADDRESS, DEPOSIT_AMOUNT_WEI] });
  await publicClient.waitForTransactionReceipt({ hash: authTxHash });
  const depositTxHash = await walletClient.writeContract({ address: t.escrow, abi: ESCROW_ABI, functionName: "deposit", args: [caseIdBytes32, escrowId, claimant, RESPONDENT_ADDRESS], value: DEPOSIT_AMOUNT_WEI });
  const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositTxHash });
  console.log(`[full-chain] deposit tx: ${depositTxHash}`);

  await prisma.caseSettlement.update({ where: { id: caseSettlement.id }, data: { status: "DEPOSITED", depositTxHash, depositConfirmedAt: new Date(), depositAuthorizedAt: new Date(), depositAuthorizeTxHash: authTxHash } });

  // 3. REAL GenLayer adjudication — first decision (opens appeal window).
  console.log(`[full-chain] calling runAdjudicationJob (real GenLayer deploy + adjudicate)...`);
  await runAdjudicationJob(kase.id, false);
  let updatedCase = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
  let firstDecision = await prisma.decision.findFirstOrThrow({ where: { caseId: kase.id }, orderBy: { createdAt: "desc" } });
  console.log(`[full-chain] first decision: outcome=${firstDecision.outcome} consensus=${firstDecision.consensus} case.status=${updatedCase.status} adjudicateTxHash=${firstDecision.adjudicateTxHash}`);
  if (updatedCase.status !== "APPEAL_WINDOW") {
    throw new Error(`expected case status APPEAL_WINDOW after first decision, got ${updatedCase.status} (consensus=${firstDecision.consensus}) — real GenLayer did not produce the expected result; inspect case ${kase.id} manually before proceeding`);
  }

  // 4. REAL appeal — MAX_APPEALS=1 means this reaches FINALIZED immediately,
  // a genuine second round of GenLayer consensus, not a skip.
  console.log(`[full-chain] calling runAdjudicationJob (real GenLayer appeal)...`);
  await runAdjudicationJob(kase.id, true);
  updatedCase = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
  const finalDecision = await prisma.decision.findFirstOrThrow({ where: { caseId: kase.id }, orderBy: { createdAt: "desc" } });
  console.log(`[full-chain] final decision: outcome=${finalDecision.outcome} consensus=${finalDecision.consensus} case.status=${updatedCase.status} adjudicateTxHash=${finalDecision.adjudicateTxHash}`);
  if (updatedCase.status !== "FINALIZED") {
    throw new Error(`expected case status FINALIZED after appeal, got ${updatedCase.status}`);
  }
  if (finalDecision.consensus !== "ACCEPTED") {
    throw new Error(`final decision consensus is ${finalDecision.consensus}, not ACCEPTED — cannot settle an undetermined decision`);
  }
  if (finalDecision.relayError !== SETTLEMENT_BLOCKED_PAUSED) {
    throw new Error(`expected relayError SETTLEMENT_BLOCKED_PAUSED (proving dispatchSettlementForDecision was correctly blocked by the pause), got: ${finalDecision.relayError}`);
  }
  if (finalDecision.relayTxHash) {
    throw new Error(`decision already has relayTxHash ${finalDecision.relayTxHash} — automated dispatch was NOT blocked as expected; aborting rather than double-settle`);
  }
  console.log(`[full-chain] confirmed: real GenLayer decision is FINALIZED and ACCEPTED, and dispatchSettlementForDecision was correctly blocked by SETTLEMENT_PAUSED (relayError=${finalDecision.relayError}). Proceeding with a separate, manual attestedSettle() call using this decision's real proof.`);

  if (!finalDecision.decisionHash) throw new Error("final decision has no decisionHash");
  const proofHash = `0x${finalDecision.decisionHash}` as Hex;
  const outcome = finalDecision.outcome;
  const claimantShareBps = finalDecision.claimantShareBps ?? 0;
  const respondentShareBps = finalDecision.respondentShareBps ?? 0;
  const claimantAmount = (DEPOSIT_AMOUNT_WEI * BigInt(claimantShareBps)) / 10000n;
  const respondentAmount = DEPOSIT_AMOUNT_WEI - claimantAmount;
  console.log(`[full-chain] real outcome: ${outcome}, claimantShareBps=${claimantShareBps}, respondentShareBps=${respondentShareBps} -> claimantAmount=${claimantAmount} respondentAmount=${respondentAmount}`);

  // 5. Attestation + direct settlement (identical mechanics to the
  // isolated payout proof, but every value here — proofHash, outcome,
  // shares — came from a REAL GenLayer decision above, not a fabricated one).
  const chainId = await publicClient.getChainId();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const attestationHash = computeDirectSettleAttestationHash({ chainId, recipientAddress: t.decisionRelay, settlementTargetAddr: t.escrow, caseIdBytes32, outcome, claimantAmount, respondentAmount, escrowId, proofHash, deadline });
  const backendSignature = await attestorAccount.sign({ hash: attestationHash });

  await prisma.decision.update({ where: { id: finalDecision.id }, data: { pendingAttestationHash: attestationHash, pendingAttestationSignatures: [backendSignature] } });
  console.log(`[full-chain] waiting for a real second attestor signature from the live automated attestor service (up to ${POLL_TIMEOUT_MS / 1000}s)...`);

  const respondentBalanceBefore = await publicClient.getBalance({ address: RESPONDENT_ADDRESS });
  const waitUntil = Date.now() + POLL_TIMEOUT_MS;
  let signatures: string[] = [backendSignature];
  while (Date.now() < waitUntil) {
    await sleep(POLL_INTERVAL_MS);
    const refreshed = await prisma.decision.findUniqueOrThrow({ where: { id: finalDecision.id } });
    signatures = refreshed.pendingAttestationSignatures;
    console.log(`[full-chain]   ${signatures.length} signature(s) collected so far...`);
    if (signatures.length >= t.attestorThreshold) break;
  }
  if (signatures.length < t.attestorThreshold) {
    throw new Error(`only ${signatures.length}/${t.attestorThreshold} attestor signatures collected in time — decision ${finalDecision.id} left in place for manual inspection`);
  }

  console.log(`[full-chain] submitting attestedSettle() with the real GenLayer-decided outcome...`);
  const { txHash: settlementTxHash } = await submitAttestedSettle({ originChain: "sepolia", privateKey: dispatchKey, rpcUrl: RPC_URL }, t.decisionRelay, { caseId: kase.id, outcome, claimantAmount, respondentAmount, escrowId, proofHash, settlementTargetAddr: t.escrow, deadline, attestationSignatures: signatures as Hex[] });
  console.log(`[full-chain] attestedSettle() tx: ${settlementTxHash}`);

  await prisma.decision.update({ where: { id: finalDecision.id }, data: { relayTxHash: settlementTxHash } });
  await prisma.caseSettlement.update({ where: { id: caseSettlement.id }, data: { status: "SETTLED", settledTxHash: settlementTxHash, settledAt: new Date() } });

  // 6. Verify.
  const escrowStateAfter = await publicClient.readContract({ address: t.escrow, abi: ESCROW_ABI, functionName: "deposits", args: [escrowId] });
  const processed = await publicClient.readContract({ address: t.decisionRelay, abi: DECISION_RELAY_ABI, functionName: "processedDecisions", args: [proofHash] });
  if (Number(escrowStateAfter[0]) !== 2) throw new Error(`escrow status after settle is ${escrowStateAfter[0]}, expected 2 (SETTLED)`);
  if (!processed) throw new Error("processedDecisions(proofHash) is false after settlement");
  const respondentBalanceAfter = await publicClient.getBalance({ address: RESPONDENT_ADDRESS });
  const respondentDelta = respondentBalanceAfter - respondentBalanceBefore;
  console.log(`[full-chain] respondent balance delta: ${respondentDelta} wei (expected ${respondentAmount})`);
  if (respondentDelta !== respondentAmount) throw new Error(`respondent delta ${respondentDelta} != expected ${respondentAmount}`);

  // 7. Proof bundle.
  const write = (name: string, data: unknown) => writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2) + "\n");
  write("case.json", { chain: "sepolia", caseId: kase.id, organizationId: org.id, claim: kase.claim, policyId: kase.policyId, policyVersion: kase.policyVersion, timestamp: nowIso() });
  write("genlayer-first-decision.json", { decisionId: firstDecision.id, caseId: kase.id, outcome: firstDecision.outcome, consensus: firstDecision.consensus, adjudicateTxHash: firstDecision.adjudicateTxHash, decisionHash: firstDecision.decisionHash, contractAddress: (await prisma.case.findUniqueOrThrow({ where: { id: kase.id } })).contractAddress });
  write("genlayer-final-decision.json", { decisionId: finalDecision.id, caseId: kase.id, outcome: finalDecision.outcome, consensus: finalDecision.consensus, claimantShareBps, respondentShareBps, adjudicateTxHash: finalDecision.adjudicateTxHash, decisionHash: finalDecision.decisionHash, proofHash: finalDecision.proofHash, relayErrorAtFinalization: "SETTLEMENT_BLOCKED_PAUSED (confirms real automated dispatch was correctly blocked by the standing pause)" });
  write("settlement-pause-proof.json", { settlementPausedEnvVar: true, dispatchSettlementForDecisionBlocked: true, note: "runAdjudicationJob's internal dispatchSettlementForDecision call was invoked for real and correctly refused to settle, recording relayError=SETTLEMENT_BLOCKED_PAUSED. The settlement below was submitted as a separate, manual, explicitly-authorized call using the real decision's real proof — SETTLEMENT_PAUSED itself was never lifted." });
  write("attestation-payload.json", { chain: "sepolia", chainId, decisionRelay: t.decisionRelay, settlementTargetAddr: t.escrow, caseIdBytes32, outcome, claimantAmount: claimantAmount.toString(), respondentAmount: respondentAmount.toString(), escrowId, proofHash, deadline: deadline.toString(), attestationHash, hashScheme: "ANCHOR_DIRECT_SETTLE_V1" });
  write("signatures.json", { chain: "sepolia", attestorThreshold: t.attestorThreshold, signaturesCollected: signatures.length, signatures });
  write("deposit-tx.json", { chain: "sepolia", contract: t.escrow, authorizeDepositTxHash: authTxHash, depositTxHash, blockNumber: depositReceipt.blockNumber.toString(), timestamp: nowIso() });
  write("settlement-tx.json", { chain: "sepolia", contract: t.decisionRelay, settlementTxHash, timestamp: nowIso() });
  write("escrow-state-after.json", { chain: "sepolia", escrowContract: t.escrow, escrowId, status: Number(escrowStateAfter[0]), amount: escrowStateAfter[3].toString(), processedDecisions: processed });
  write("balance-deltas.json", { chain: "sepolia", respondent: { address: RESPONDENT_ADDRESS, before: respondentBalanceBefore.toString(), after: respondentBalanceAfter.toString(), delta: respondentDelta.toString(), expectedDelta: respondentAmount.toString(), match: respondentDelta === respondentAmount } });

  console.log(`\n[full-chain] SUCCESS — real GenLayer decision -> real attestedSettle() payout proven. Bundle written to ${outDir}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[full-chain] FAILED:", err);
  await prisma.$disconnect();
  process.exit(1);
});
