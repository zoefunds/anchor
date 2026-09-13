// Phase 2 acceptance test (2026-09-13 remediation plan): a repeatable,
// funded, app-level proof that a real Sepolia case settles through
// attestedSettle() — no relayer, no validator, no Hyperlane dependency
// in the payout path at all. Uses the SAME functions the real
// application uses (computeDirectSettleAttestationHash,
// submitAttestedSettle from @anchor/hyperlane-relay) rather than a
// Foundry-only unit test, and drives real signing through the same
// two-tier flow the app relies on in production: one signature from
// this backend's own ATTESTOR_PRIVATE_KEYS, one from a REAL,
// independently-running automated attestor service (anc-hor-attestor2)
// via the same Decision.pendingAttestationHash + POST
// /api/internal/pending-attestations/[id]/sign workflow production
// uses — never a locally-fabricated second signature.
//
// Deliberately does NOT go through dispatchDecisionForCase/
// retryFailedSettlements (the automated worker path gated by
// SETTLEMENT_PAUSED) — this is a manual, human-initiated rehearsal
// script for one specific test case, not a change to (or bypass of)
// the standing pause on automated dispatch.
//
// Run: npx tsx scripts/e2e-sepolia-attested-settle.ts
//
// Writes a JSON proof bundle to artifacts/submission/sepolia/.
import { createPublicClient, createWalletClient, http, type Address, type Hex, keccak256, encodePacked, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { computeDirectSettleAttestationHash, submitAttestedSettle, caseIdToBytes32 } from "@anchor/hyperlane-relay";
import { ACTIVE_SEPOLIA_TOPOLOGY } from "../src/lib/deployment-registry";
import { prisma } from "../src/lib/prisma";

const RPC_URL = process.env.HYPERLANE_RELAY_RPC_URL ?? "https://ethereum-sepolia.publicnode.com";
const DISPATCH_PRIVATE_KEY = (process.env.HYPERLANE_RELAY_PRIVATE_KEY ?? "").trim();
if (!DISPATCH_PRIVATE_KEY) throw new Error("HYPERLANE_RELAY_PRIVATE_KEY is required (same key used for deposit-authorizer/claimant/dispatcher in this rehearsal)");
const dispatchKey = (DISPATCH_PRIVATE_KEY.startsWith("0x") ? DISPATCH_PRIVATE_KEY : `0x${DISPATCH_PRIVATE_KEY}`) as Hex;

const ATTESTOR_PRIVATE_KEY = (process.env.ATTESTOR_PRIVATE_KEYS ?? process.env.ATTESTOR_PRIVATE_KEY ?? "").split(",")[0]?.trim();
if (!ATTESTOR_PRIVATE_KEY) throw new Error("ATTESTOR_PRIVATE_KEYS (or ATTESTOR_PRIVATE_KEY) is required — this backend's own attestor signature");
const attestorKey = (ATTESTOR_PRIVATE_KEY.startsWith("0x") ? ATTESTOR_PRIVATE_KEY : `0x${ATTESTOR_PRIVATE_KEY}`) as Hex;

// Deliberately small — this is a proof-of-flow rehearsal, not a real
// dispute payout. Must stay under AUTO_ATTESTOR_MAX_AMOUNT_ETH (the
// real, currently-running automated attestor's own policy cap) or the
// live service will correctly refuse to auto-sign it.
const DEPOSIT_AMOUNT_WEI = 200_000_000_000_000n; // 0.0002 ETH
const RESPONDENT_ADDRESS = getAddress("0x000000000000000000000000000000000000b0b0"); // fixed test respondent — receives 0 in this RELEASE_FULL rehearsal
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 180_000; // real anc-hor-attestor2 polls every 60s by default

const DECISION_RELAY_ABI = [
  { type: "function", name: "processedDecisions", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

const ESCROW_ABI = [
  {
    type: "function",
    name: "authorizeDeposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "caseId", type: "bytes32" },
      { name: "escrowId", type: "bytes32" },
      { name: "claimant", type: "address" },
      { name: "respondent", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "caseId", type: "bytes32" },
      { name: "escrowId", type: "bytes32" },
      { name: "claimant", type: "address" },
      { name: "respondent", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "deposits",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "claimant", type: "address" },
      { name: "respondent", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "caseId", type: "bytes32" },
      { name: "depositedAt", type: "uint256" },
    ],
  },
] as const;

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(input: string): string {
  const { createHash } = require("crypto");
  return createHash("sha256").update(input).digest("hex");
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
  const dispatchAccount = privateKeyToAccount(dispatchKey);
  const walletClient = createWalletClient({ chain: sepolia, transport: http(RPC_URL), account: dispatchAccount });
  const attestorAccount = privateKeyToAccount(attestorKey);

  const claimant = dispatchAccount.address; // this rehearsal's claimant IS the dispatch/depositAuthorizer key — a self-funded test deposit, not a real dispute
  const t = ACTIVE_SEPOLIA_TOPOLOGY;
  const outDir = path.resolve(__dirname, "../../../artifacts/submission/sepolia");
  mkdirSync(outDir, { recursive: true });

  console.log(`[e2e] chain: sepolia (${sepolia.id})`);
  console.log(`[e2e] DecisionRelay: ${t.decisionRelay}`);
  console.log(`[e2e] Escrow: ${t.escrow}`);
  console.log(`[e2e] claimant/depositAuthorizer/dispatcher: ${claimant}`);
  console.log(`[e2e] deposit amount: ${DEPOSIT_AMOUNT_WEI} wei`);

  // 1. Organization + integration (idempotent — reuse if this script has run before).
  let org = await prisma.organization.findFirst({ where: { name: "e2e-sepolia-attested-settle" } });
  if (!org) org = await prisma.organization.create({ data: { name: "e2e-sepolia-attested-settle" } });
  console.log(`[e2e] organization: ${org.id}`);

  let integration = await prisma.settlementIntegration.findFirst({
    where: { organizationId: org.id, chain: "sepolia", escrowContractAddress: t.escrow, active: true },
  });
  if (!integration) {
    integration = await prisma.settlementIntegration.create({
      data: {
        organizationId: org.id,
        chain: "sepolia",
        escrowContractAddress: t.escrow,
        assetSymbol: "ETH",
        assetDecimals: 18,
        escrowVersion: "V2",
        createdByMemberId: "e2e-script",
      },
    });
  }
  console.log(`[e2e] integration: ${integration.id}`);

  // 2. Case + CaseSettlement.
  const kase = await prisma.case.create({
    data: {
      organizationId: org.id,
      claim: "Phase 2 acceptance rehearsal — attestedSettle() direct payout proof",
      amount: "0.0002",
      currency: "ETH",
      policyId: "e2e-attested-settle-rehearsal",
      policyVersion: "v1",
      claimantRef: "e2e-claimant",
      respondentRef: "e2e-respondent",
      settlementChain: "sepolia",
      settlementContract: t.decisionRelay,
      status: "FINALIZED",
    },
  });
  console.log(`[e2e] case: ${kase.id}`);

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
  console.log(`[e2e] caseSettlement: ${caseSettlement.id}`);

  // 3. authorizeDeposit() + deposit() — real on-chain transactions.
  console.log(`[e2e] authorizing deposit on-chain...`);
  const authTxHash = await walletClient.writeContract({
    address: t.escrow,
    abi: ESCROW_ABI,
    functionName: "authorizeDeposit",
    args: [caseIdBytes32, escrowId, claimant, RESPONDENT_ADDRESS, DEPOSIT_AMOUNT_WEI],
  });
  await publicClient.waitForTransactionReceipt({ hash: authTxHash });
  console.log(`[e2e] authorizeDeposit tx: ${authTxHash}`);

  const claimantBalanceBefore = await publicClient.getBalance({ address: claimant });
  const respondentBalanceBefore = await publicClient.getBalance({ address: RESPONDENT_ADDRESS });

  console.log(`[e2e] depositing on-chain...`);
  const depositTxHash = await walletClient.writeContract({
    address: t.escrow,
    abi: ESCROW_ABI,
    functionName: "deposit",
    args: [caseIdBytes32, escrowId, claimant, RESPONDENT_ADDRESS],
    value: DEPOSIT_AMOUNT_WEI,
  });
  const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositTxHash });
  console.log(`[e2e] deposit tx: ${depositTxHash}`);

  await prisma.caseSettlement.update({
    where: { id: caseSettlement.id },
    data: { status: "DEPOSITED", depositTxHash, depositConfirmedAt: new Date(), depositAuthorizedAt: new Date(), depositAuthorizeTxHash: authTxHash },
  });

  const escrowStateBefore = await publicClient.readContract({ address: t.escrow, abi: ESCROW_ABI, functionName: "deposits", args: [escrowId] });
  console.log(`[e2e] escrow state after deposit: status=${escrowStateBefore[0]} amount=${escrowStateBefore[3]}`);

  // 4. Finalized decision.
  const outcome = "RELEASE_FULL";
  const claimantAmount = DEPOSIT_AMOUNT_WEI;
  const respondentAmount = 0n;
  const decisionContent = JSON.stringify({ caseId: kase.id, policyId: kase.policyId, policyVersion: kase.policyVersion, outcome, claimantShareBps: 10000, respondentShareBps: 0 });
  const decisionHashHex = sha256Hex(decisionContent);
  const proofHash = `0x${decisionHashHex}` as Hex;

  const decision = await prisma.decision.create({
    data: {
      caseId: kase.id,
      policyId: kase.policyId,
      policyVersion: kase.policyVersion,
      outcome,
      claimantShareBps: 10000,
      respondentShareBps: 0,
      consensus: "ACCEPTED",
      decisionHash: decisionHashHex,
      proofHash: decisionHashHex,
    },
  });
  console.log(`[e2e] decision: ${decision.id}`);

  // 5. Compute the attestedSettle() digest exactly as DecisionRelay.sol
  // and hyperlane.ts do, and collect signatures — one held by this
  // backend, one from the real, independently-running automated
  // attestor service (via the actual production sign workflow, never a
  // locally-fabricated second key).
  const chainId = await publicClient.getChainId();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const attestationHash = computeDirectSettleAttestationHash({
    chainId,
    recipientAddress: t.decisionRelay,
    settlementTargetAddr: t.escrow,
    caseIdBytes32,
    outcome,
    claimantAmount,
    respondentAmount,
    escrowId,
    proofHash,
    deadline,
  });

  const backendSignature = await attestorAccount.sign({ hash: attestationHash });

  await prisma.decision.update({
    where: { id: decision.id },
    data: { pendingAttestationHash: attestationHash, pendingAttestationSignatures: [backendSignature] },
  });
  console.log(`[e2e] attestedSettle() digest: ${attestationHash}`);
  console.log(`[e2e] backend signature collected: ${backendSignature}`);
  console.log(`[e2e] waiting for a real second signature from the live automated attestor service (up to ${POLL_TIMEOUT_MS / 1000}s)...`);

  const deadlineWaitUntil = Date.now() + POLL_TIMEOUT_MS;
  let signatures: string[] = [backendSignature];
  while (Date.now() < deadlineWaitUntil) {
    await sleep(POLL_INTERVAL_MS);
    const refreshed = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    signatures = refreshed.pendingAttestationSignatures;
    console.log(`[e2e]   ${signatures.length} signature(s) collected so far...`);
    if (signatures.length >= t.attestorThreshold) break;
  }

  if (signatures.length < t.attestorThreshold) {
    throw new Error(
      `Only ${signatures.length}/${t.attestorThreshold} attestor signatures collected after ${POLL_TIMEOUT_MS / 1000}s — the live automated attestor service did not sign in time. ` +
        `Check anc-hor-attestor2/3's own logs and AUTO_ATTESTOR_MAX_AMOUNT_ETH policy cap; decision ${decision.id} is left in place for manual inspection.`
    );
  }

  console.log(`[e2e] reached ${signatures.length}/${t.attestorThreshold} attestor signatures.`);

  // 6. Submit attestedSettle() — the real, direct, same-chain payout call.
  console.log(`[e2e] submitting attestedSettle()...`);
  const { txHash: settlementTxHash } = await submitAttestedSettle(
    { originChain: "sepolia", privateKey: dispatchKey, rpcUrl: RPC_URL },
    t.decisionRelay,
    {
      caseId: kase.id,
      outcome,
      claimantAmount,
      respondentAmount,
      escrowId,
      proofHash,
      settlementTargetAddr: t.escrow,
      deadline,
      attestationSignatures: signatures as Hex[],
    }
  );
  console.log(`[e2e] attestedSettle() tx: ${settlementTxHash}`);

  await prisma.decision.update({ where: { id: decision.id }, data: { relayTxHash: settlementTxHash } });
  await prisma.caseSettlement.update({ where: { id: caseSettlement.id }, data: { status: "SETTLED", settledTxHash: settlementTxHash, settledAt: new Date() } });

  // 7. Verify: escrow state, exact balance deltas, on-chain replay-guard state.
  const escrowStateAfter = await publicClient.readContract({ address: t.escrow, abi: ESCROW_ABI, functionName: "deposits", args: [escrowId] });
  const processed = await publicClient.readContract({ address: t.decisionRelay, abi: DECISION_RELAY_ABI, functionName: "processedDecisions", args: [proofHash] });
  console.log(`[e2e] escrow state after settle: status=${escrowStateAfter[0]} (2=SETTLED) processedDecisions(proofHash)=${processed}`);
  if (Number(escrowStateAfter[0]) !== 2) throw new Error(`escrow status after settle is ${escrowStateAfter[0]}, expected 2 (SETTLED)`);
  if (!processed) throw new Error("processedDecisions(proofHash) is false after a successful attestedSettle() — replay guard did not record it");

  const claimantBalanceAfter = await publicClient.getBalance({ address: claimant });
  const respondentBalanceAfter = await publicClient.getBalance({ address: RESPONDENT_ADDRESS });
  // claimant's net delta also reflects gas spent on authorizeDeposit/deposit/settle txs from the same key in this rehearsal (it plays claimant AND dispatcher) — respondent's delta is the clean, gas-free signal.
  const respondentDelta = respondentBalanceAfter - respondentBalanceBefore;
  console.log(`[e2e] respondent balance delta: ${respondentDelta} wei (expected ${respondentAmount})`);
  if (respondentDelta !== respondentAmount) throw new Error(`respondent balance delta ${respondentDelta} does not match decision respondentAmount ${respondentAmount}`);

  // 8. Replay attempt — must fail.
  console.log(`[e2e] attempting replay of attestedSettle() with the same proofHash (must fail)...`);
  let replayError: string | null = null;
  try {
    await submitAttestedSettle(
      { originChain: "sepolia", privateKey: dispatchKey, rpcUrl: RPC_URL },
      t.decisionRelay,
      { caseId: kase.id, outcome, claimantAmount, respondentAmount, escrowId, proofHash, settlementTargetAddr: t.escrow, deadline, attestationSignatures: signatures as Hex[] }
    );
  } catch (err) {
    replayError = err instanceof Error ? err.message : String(err);
  }
  if (!replayError) throw new Error("replay of attestedSettle() with an already-processed proofHash SUCCEEDED — replay guard is broken");
  console.log(`[e2e] replay correctly rejected: ${replayError.slice(0, 200)}`);

  // 9. Proof bundle.
  const write = (name: string, data: unknown) => writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2) + "\n");

  write("case.json", { chain: "sepolia", caseId: kase.id, organizationId: org.id, integrationId: integration.id, claim: kase.claim, currency: kase.currency, amount: kase.amount, timestamp: nowIso() });
  write("decision.json", { chain: "sepolia", decisionId: decision.id, caseId: kase.id, outcome, claimantShareBps: 10000, respondentShareBps: 0, decisionHash: decisionHashHex, proofHash, timestamp: nowIso() });
  write("attestation-payload.json", {
    chain: "sepolia",
    chainId,
    decisionRelay: t.decisionRelay,
    settlementTargetAddr: t.escrow,
    caseIdBytes32,
    outcome,
    claimantAmount: claimantAmount.toString(),
    respondentAmount: respondentAmount.toString(),
    escrowId,
    proofHash,
    deadline: deadline.toString(),
    attestationHash,
    hashScheme: "ANCHOR_DIRECT_SETTLE_V1",
  });
  write("signatures.json", { chain: "sepolia", attestorThreshold: t.attestorThreshold, signaturesCollected: signatures.length, signatures });
  write("deposit-tx.json", { chain: "sepolia", contract: t.escrow, authorizeDepositTxHash: authTxHash, depositTxHash, blockNumber: depositReceipt.blockNumber.toString(), timestamp: nowIso() });
  write("settlement-tx.json", { chain: "sepolia", contract: t.decisionRelay, settlementTxHash, timestamp: nowIso() });
  write("escrow-state-before.json", { chain: "sepolia", escrowContract: t.escrow, escrowId, status: Number(escrowStateBefore[0]), claimant: escrowStateBefore[1], respondent: escrowStateBefore[2], amount: escrowStateBefore[3].toString() });
  write("escrow-state-after.json", { chain: "sepolia", escrowContract: t.escrow, escrowId, status: Number(escrowStateAfter[0]), claimant: escrowStateAfter[1], respondent: escrowStateAfter[2], amount: escrowStateAfter[3].toString(), processedDecisions: processed });
  write("balance-deltas.json", {
    chain: "sepolia",
    claimant: { address: claimant, before: claimantBalanceBefore.toString(), after: claimantBalanceAfter.toString(), note: "claimant is also the depositAuthorizer/dispatcher key in this rehearsal — its delta includes gas spent on all transactions, not just the settlement payout" },
    respondent: { address: RESPONDENT_ADDRESS, before: respondentBalanceBefore.toString(), after: respondentBalanceAfter.toString(), delta: respondentDelta.toString(), expectedDelta: respondentAmount.toString(), match: respondentDelta === respondentAmount },
  });
  write("replay-rejection.json", { chain: "sepolia", attemptedProofHash: proofHash, rejected: true, errorMessage: replayError });

  console.log(`\n[e2e] SUCCESS — proof bundle written to ${outDir}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[e2e] FAILED:", err);
  await prisma.$disconnect();
  process.exit(1);
});
