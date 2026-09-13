// Real case creation (2026-09-13, post-pause-lift): a genuinely live
// case using real, user-supplied claimant/respondent addresses — unlike
// every e2e-*/rehearsal script tonight, which used the same
// dispatch-controlled key for every role. This script does everything
// that does NOT require the claimant's own signature (case + evidence
// creation, on-chain authorizeDeposit()), then prints the exact
// transaction details for the claimant to submit themselves — their
// private key is never available to this process, nor should it be.
//
// Once a real deposit is confirmed on-chain, run this script again with
// --adjudicate <caseId> to trigger real GenLayer adjudication. Because
// SETTLEMENT_PAUSED is now off, a real FINALIZED ACCEPTED decision will
// dispatch settlement AUTOMATICALLY via the real dispatchSettlementForDecision
// path — no manual rehearsal authorization needed anymore.
//
// Run: npx tsx scripts/create-real-case-invoice-dispute.ts
//      npx tsx scripts/create-real-case-invoice-dispute.ts --adjudicate <caseId>
import { createWalletClient, createPublicClient, http, type Hex, keccak256, encodePacked, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { createHash } from "crypto";
import { caseIdToBytes32 } from "@anchor/hyperlane-relay";
import { ACTIVE_SEPOLIA_TOPOLOGY } from "../src/lib/deployment-registry";
import { prisma } from "../src/lib/prisma";
import { runAdjudicationJob, isSettlementPaused } from "../src/lib/adjudication-service";

const RPC_URL = process.env.HYPERLANE_RELAY_RPC_URL ?? "https://ethereum-sepolia.publicnode.com";
const dispatchKey = (process.env.HYPERLANE_RELAY_PRIVATE_KEY!.startsWith("0x") ? process.env.HYPERLANE_RELAY_PRIVATE_KEY! : `0x${process.env.HYPERLANE_RELAY_PRIVATE_KEY}`) as Hex;

const CLAIMANT = getAddress("0x07cbe0D76331b0cc66cbA54F0caB3C51b75bf80c");
const RESPONDENT = getAddress("0x1509759377876c435914b5394fa83E7391dEfbAc");
const DEPOSIT_AMOUNT_WEI = 200_000_000_000_000n; // 0.0002 ETH

const ESCROW_ABI = [
  { type: "function", name: "authorizeDeposit", stateMutability: "nonpayable", inputs: [{ name: "caseId", type: "bytes32" }, { name: "escrowId", type: "bytes32" }, { name: "claimant", type: "address" }, { name: "respondent", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [{ name: "caseId", type: "bytes32" }, { name: "escrowId", type: "bytes32" }, { name: "claimant", type: "address" }, { name: "respondent", type: "address" }], outputs: [] },
] as const;

async function createCase() {
  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
  const dispatchAccount = privateKeyToAccount(dispatchKey);
  const walletClient = createWalletClient({ chain: sepolia, transport: http(RPC_URL), account: dispatchAccount });
  const t = ACTIVE_SEPOLIA_TOPOLOGY;

  let org = await prisma.organization.findFirst({ where: { name: "real-cases" } });
  if (!org) org = await prisma.organization.create({ data: { name: "real-cases" } });
  let integration = await prisma.settlementIntegration.findFirst({ where: { organizationId: org.id, chain: "sepolia", escrowContractAddress: t.escrow, active: true } });
  if (!integration) {
    integration = await prisma.settlementIntegration.create({ data: { organizationId: org.id, chain: "sepolia", escrowContractAddress: t.escrow, assetSymbol: "ETH", assetDecimals: 18, escrowVersion: "V2", createdByMemberId: "real-case-script" } });
  }

  const kase = await prisma.case.create({
    data: {
      organizationId: org.id,
      claim: "Buyer disputes a $[invoice amount, atto-equivalent 0.0002 ETH] consulting-services invoice, alleging the deliverable didn't match the agreed scope. Seller maintains the work was completed exactly per the signed statement of work.",
      amount: "0.0002",
      currency: "ETH",
      policyId: "invoice_dispute_v1",
      policyVersion: "1.0.0",
      claimantRef: "buyer",
      respondentRef: "seller",
      settlementChain: "sepolia",
      settlementContract: t.decisionRelay,
      status: "EVIDENCE_COLLECTION",
    },
  });
  console.log(`case: ${kase.id}`);

  const evidenceRows: { type: string; submittedBy: "claimant" | "respondent"; storageRef: string }[] = [
    {
      type: "invoice_terms",
      submittedBy: "claimant",
      storageRef:
        "Invoice #INV-2026-0913: Statement of Work — 'Deliver a data migration script that exports all customer records from the legacy CRM (fields: name, email, phone, signup_date) into a validated CSV, with a row-count reconciliation report confirming zero data loss.' Agreed price: 0.0002 ETH. Due 2026-09-20.",
    },
    {
      type: "delivery_record",
      submittedBy: "respondent",
      storageRef:
        "Delivered on 2026-09-14: customer_export.csv containing exactly the four agreed fields (name, email, phone, signup_date) for all 12,403 customer records, plus reconciliation_report.txt showing 12,403 source rows and 12,403 exported rows — zero discrepancy. Delivery confirmed received by buyer's ops team same day.",
    },
    {
      type: "claimant_statement",
      submittedBy: "claimant",
      storageRef:
        "We received the file and it does contain all four fields with the right row count. We're disputing because we expected the phone numbers formatted in E.164 international format and they were delivered in the original mixed local format — the statement of work didn't specify a format, but we feel it should have been assumed.",
    },
    {
      type: "respondent_statement",
      submittedBy: "respondent",
      storageRef:
        "The signed statement of work specifies exactly four fields with no formatting requirement of any kind for phone numbers. We delivered the data exactly as it existed in the source system, matching the agreed scope precisely, with a zero-discrepancy reconciliation report. We request full release of the invoiced amount.",
    },
  ];
  await prisma.evidence.createMany({ data: evidenceRows.map((e) => ({ caseId: kase.id, type: e.type, submittedBy: e.submittedBy, storageRef: e.storageRef, contentHash: createHash("sha256").update(e.storageRef).digest("hex") })) });
  console.log(`evidence submitted (${evidenceRows.length} items)`);

  const caseIdBytes32 = caseIdToBytes32(kase.id);
  const escrowIdSeed = `${kase.id}:${Date.now()}`;
  const escrowId = keccak256(encodePacked(["string"], [escrowIdSeed]));

  const caseSettlement = await prisma.caseSettlement.create({
    data: {
      caseId: kase.id,
      integrationId: integration.id,
      escrowId,
      claimantAddress: CLAIMANT,
      claimantAddressSetAt: new Date(),
      respondentAddress: RESPONDENT,
      respondentAddressSetAt: new Date(),
      expectedAmountAtto: DEPOSIT_AMOUNT_WEI.toString(),
      status: "PENDING_DEPOSIT",
    },
  });

  console.log(`authorizing deposit on-chain (backend action, no claimant signature needed)...`);
  const authTxHash = await walletClient.writeContract({ address: t.escrow, abi: ESCROW_ABI, functionName: "authorizeDeposit", args: [caseIdBytes32, escrowId, CLAIMANT, RESPONDENT, DEPOSIT_AMOUNT_WEI] });
  await publicClient.waitForTransactionReceipt({ hash: authTxHash });
  await prisma.caseSettlement.update({ where: { id: caseSettlement.id }, data: { depositAuthorizedAt: new Date(), depositAuthorizeTxHash: authTxHash } });
  console.log(`authorizeDeposit tx: ${authTxHash}`);

  console.log(`\n=== ACTION NEEDED: the claimant must submit this transaction themselves ===`);
  console.log(`From address: ${CLAIMANT}`);
  console.log(`To contract: ${t.escrow}`);
  console.log(`Function: deposit(bytes32 caseId, bytes32 escrowId, address claimant, address respondent)`);
  console.log(`Args:`);
  console.log(`  caseId:     ${caseIdBytes32}`);
  console.log(`  escrowId:   ${escrowId}`);
  console.log(`  claimant:   ${CLAIMANT}`);
  console.log(`  respondent: ${RESPONDENT}`);
  console.log(`Value: ${DEPOSIT_AMOUNT_WEI} wei (0.0002 ETH) — must match exactly`);
  console.log(`\nVia Etherscan: https://sepolia.etherscan.io/address/${t.escrow}#writeContract (connect the claimant wallet, call "deposit")`);
  console.log(`\nOnce that transaction confirms, run:\n  npx tsx scripts/create-real-case-invoice-dispute.ts --adjudicate ${kase.id}`);

  await prisma.$disconnect();
}

async function adjudicate(caseId: string) {
  const kase = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
  const caseSettlement = await prisma.caseSettlement.findUniqueOrThrow({ where: { caseId } });
  const t = ACTIVE_SEPOLIA_TOPOLOGY;
  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

  const ESCROW_READ_ABI = [{ type: "function", name: "deposits", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ name: "status", type: "uint8" }, { name: "claimant", type: "address" }, { name: "respondent", type: "address" }, { name: "amount", type: "uint256" }, { name: "caseId", type: "bytes32" }, { name: "depositedAt", type: "uint256" }] }] as const;
  const escrowId = caseSettlement.escrowId as Hex;
  const state = await publicClient.readContract({ address: t.escrow, abi: ESCROW_READ_ABI, functionName: "deposits", args: [escrowId] });
  console.log(`live escrow status: ${state[0]} (1=DEPOSITED required)`);
  if (Number(state[0]) !== 1) {
    throw new Error(`escrow status is ${state[0]}, not DEPOSITED (1) — the claimant's deposit transaction has not confirmed yet`);
  }

  await prisma.caseSettlement.update({ where: { id: caseSettlement.id }, data: { status: "DEPOSITED", depositConfirmedAt: new Date() } });
  console.log(`deposit confirmed on-chain — real amount: ${state[3]} wei`);

  console.log(`SETTLEMENT_PAUSED is currently: ${isSettlementPaused()}`);
  console.log(`calling real GenLayer adjudication (this will automatically dispatch settlement if it reaches FINALIZED+ACCEPTED, since the pause is off)...`);
  await runAdjudicationJob(caseId, false);
  let updated = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
  let decision = await prisma.decision.findFirstOrThrow({ where: { caseId }, orderBy: { createdAt: "desc" } });
  console.log(`first decision: outcome=${decision.outcome} consensus=${decision.consensus} case.status=${updated.status}`);

  if (updated.status === "APPEAL_WINDOW") {
    console.log(`case is in its real appeal window (see Case.appealWindowClosesAt) — it will auto-finalize and auto-settle once that window closes, with NO further manual action needed, since the pause is off. To finalize immediately instead (skips the real waiting period), re-run this same function with an appeal:`);
    console.log(`  npx tsx scripts/create-real-case-invoice-dispute.ts --appeal ${caseId}`);
  } else if (updated.status === "FINALIZED") {
    decision = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    console.log(`relayTxHash: ${decision.relayTxHash ?? "(not yet — check relayError: " + decision.relayError + ")"}`);
  }

  await prisma.$disconnect();
}

async function appeal(caseId: string) {
  console.log(`calling real GenLayer appeal (real second consensus round, immediately FINALIZED per MAX_APPEALS=1)...`);
  await runAdjudicationJob(caseId, true);
  const updated = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
  const decision = await prisma.decision.findFirstOrThrow({ where: { caseId }, orderBy: { createdAt: "desc" } });
  console.log(`case.status=${updated.status} outcome=${decision.outcome} consensus=${decision.consensus} relayTxHash=${decision.relayTxHash ?? "(pending — relayError: " + decision.relayError + ")"}`);
  await prisma.$disconnect();
}

async function main() {
  const [, , flag, arg] = process.argv;
  if (flag === "--adjudicate" && arg) {
    await adjudicate(arg);
  } else if (flag === "--appeal" && arg) {
    await appeal(arg);
  } else {
    await createCase();
  }
}

main().catch(async (err) => {
  console.error("FAILED:", err);
  await prisma.$disconnect();
  process.exit(1);
});
