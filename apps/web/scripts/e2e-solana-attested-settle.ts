// Phase 3 acceptance test (2026-09-13 remediation plan) — the Solana
// equivalent of scripts/e2e-sepolia-attested-settle.ts: a repeatable,
// funded, app-level proof that a real Solana Testnet case settles
// through decision-relay's attested_settle instruction — no Hyperlane
// dependency in the payout path at all (Solana's architecture already
// worked this way before tonight; this proves it, the same way the
// Sepolia script proves the newly-added equivalent).
//
// Uses the SAME functions the real application uses
// (decisionAttestationMessage, submitAttestedSettle from
// @/lib/solana-settle) and drives the real, independently-running
// automated attestor service (anc-hor-attestor2 or 3, Ed25519/Solana
// variant) via the same Decision.pendingSolanaAttestationMessage + POST
// /api/internal/pending-solana-attestations/[id]/sign workflow
// production uses — never a locally-fabricated second signature.
//
// Escrow program flow: initializeCase() (Anchor `escrow` program) is
// what actually deposits SOL into the case PDA vault. Its `adjudicator`
// field must be set to decision-relay's own escrow_authority PDA at
// creation time — that's the account attested_settle later CPIs into
// escrow's settle() as (via invoke_signed, not a raw keypair) — so this
// script must derive and pass that PDA as `adjudicator`, not a random
// keypair, or attested_settle's later CPI will fail escrow's own
// `adjudicator == case.adjudicator` check.
//
// Run: npx tsx scripts/e2e-solana-attested-settle.ts
// Writes a JSON proof bundle to artifacts/submission/solana/.
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Connection } from "@solana/web3.js";
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { createHash } from "crypto";
import { decisionAttestationMessage, submitAttestedSettle, getSolanaAttestorThreshold } from "../src/lib/solana-settle";
import { confirmTransactionBounded } from "../src/lib/solana-confirm";
import { prisma } from "../src/lib/prisma";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com"; // Devnet since 2026-09-14 — see docs/incidents/2026-09-14-solana-devnet-migration.md
const DECISION_RELAY_PROGRAM_ID = "DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN";
const ESCROW_PROGRAM_ID = "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn";
const DEPOSIT_LAMPORTS = new anchor.BN(0.001 * LAMPORTS_PER_SOL); // small, fixed — a rehearsal, not a real dispute
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 180_000;

function nowIso() {
  return new Date().toISOString();
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRelayPayerKeypair(): Keypair {
  const raw = process.env.SOLANA_RELAY_PRIVATE_KEY;
  if (!raw) throw new Error("SOLANA_RELAY_PRIVATE_KEY is not set");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const claimant = getRelayPayerKeypair(); // self-funded rehearsal: same key plays claimant + tx payer, mirroring the Sepolia script's pattern
  const respondent = Keypair.generate();
  const decisionRelayProgramId = new PublicKey(DECISION_RELAY_PROGRAM_ID);
  const escrowProgramId = new PublicKey(ESCROW_PROGRAM_ID);

  const [escrowAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("escrow_authority")],
    decisionRelayProgramId
  );

  const outDir = path.resolve(__dirname, "../../../artifacts/submission/solana");
  mkdirSync(outDir, { recursive: true });

  console.log(`[e2e] cluster: testnet (${RPC_URL})`);
  console.log(`[e2e] decision-relay program: ${DECISION_RELAY_PROGRAM_ID}`);
  console.log(`[e2e] escrow program: ${ESCROW_PROGRAM_ID}`);
  console.log(`[e2e] escrow_authority PDA (decision-relay's CPI signer into escrow.settle): ${escrowAuthorityPda.toBase58()}`);
  console.log(`[e2e] claimant/payer: ${claimant.publicKey.toBase58()}`);
  console.log(`[e2e] respondent (fresh throwaway key): ${respondent.publicKey.toBase58()}`);

  const claimantBalance = await connection.getBalance(claimant.publicKey);
  console.log(`[e2e] claimant balance: ${claimantBalance / LAMPORTS_PER_SOL} SOL`);
  if (claimantBalance < DEPOSIT_LAMPORTS.toNumber() + 0.01 * LAMPORTS_PER_SOL) {
    throw new Error(`claimant balance too low for a ${DEPOSIT_LAMPORTS.toNumber()} lamport deposit plus fees — fund ${claimant.publicKey.toBase58()} via https://faucet.solana.com`);
  }

  // 1. Deposit — Anchor escrow program's initializeCase, adjudicator = escrow_authority PDA.
  const idl = JSON.parse(readFileSync(path.resolve(__dirname, "../../../chains/solana/target/idl/escrow.json"), "utf-8"));
  const provider = new anchor.AnchorProvider(
    connection,
    // AnchorProvider needs a Wallet-shaped signer; wrap the raw Keypair directly.
    { publicKey: claimant.publicKey, signTransaction: async (tx: any) => { tx.sign(claimant); return tx; }, signAllTransactions: async (txs: any[]) => { txs.forEach((tx) => tx.sign(claimant)); return txs; } } as anchor.Wallet,
    { commitment: "confirmed" }
  );
  const program = new (anchor as any).Program(idl, provider);

  const caseId = `e2e-as-${Date.now()}`; // Solana PDA seeds cap at 32 bytes each — must stay short
  const [casePda] = PublicKey.findProgramAddressSync([Buffer.from("case"), Buffer.from(caseId)], escrowProgramId);
  console.log(`[e2e] caseId: ${caseId} -> case PDA ${casePda.toBase58()}`);

  console.log(`[e2e] depositing on-chain (initializeCase)...`);
  // Built and confirmed manually rather than via Anchor's own .rpc()
  // (which uses connection.confirmTransaction's websocket-subscription
  // wait, no bounded timeout) — see solana-confirm.ts's own doc comment:
  // this exact confirmation strategy was found live to hang/time out
  // against public Solana RPCs during the 2026-09-12 incident, and the
  // same behavior reproduced here (twice) against this same RPC.
  const depositIx = await program.methods
    .initializeCase(caseId, respondent.publicKey, escrowAuthorityPda, DEPOSIT_LAMPORTS)
    .accounts({ claimant: claimant.publicKey, case: casePda, systemProgram: SystemProgram.programId })
    .instruction();
  const { blockhash: depositBlockhash, lastValidBlockHeight: depositLastValidBlockHeight } = await connection.getLatestBlockhash();
  const depositTx = new anchor.web3.Transaction({ recentBlockhash: depositBlockhash, feePayer: claimant.publicKey }).add(depositIx);
  depositTx.sign(claimant);
  const depositTxSig = await connection.sendRawTransaction(depositTx.serialize(), { skipPreflight: false });
  await confirmTransactionBounded({ connection, signature: depositTxSig, lastValidBlockHeight: depositLastValidBlockHeight, timeoutMs: 90_000 });
  console.log(`[e2e] deposit tx: ${depositTxSig}`);

  const caseStateBefore = await program.account.case.fetch(casePda);
  const vaultBalanceBefore = await connection.getBalance(casePda);
  console.log(`[e2e] case status after deposit: ${JSON.stringify(caseStateBefore.status)}, vault balance: ${vaultBalanceBefore} lamports`);

  // 2. Decision + attestation message.
  const claimantShareBps = 10000; // RELEASE_FULL
  const respondentShareBps = 0;
  const decisionContent = JSON.stringify({ caseId, outcome: "RELEASE_FULL", claimantShareBps, respondentShareBps });
  const decisionHash = createHash("sha256").update(decisionContent).digest();

  const message = decisionAttestationMessage({
    decisionRelayProgramId: DECISION_RELAY_PROGRAM_ID,
    caseId,
    claimant: claimant.publicKey.toBase58(),
    respondent: respondent.publicKey.toBase58(),
    escrowProgram: ESCROW_PROGRAM_ID,
    claimantShareBps,
    respondentShareBps,
    decisionHash,
  });
  const messageHex = `0x${message.toString("hex")}`;
  console.log(`[e2e] decision attestation message: ${messageHex}`);

  // Real Decision row so the LIVE, independently-running automated
  // Solana attestor (anc-hor-attestor2/3) can discover and sign it via
  // its own normal polling — never a locally-fabricated second key.
  const org = (await prisma.organization.findFirst({ where: { name: "e2e-solana-attested-settle" } })) ?? (await prisma.organization.create({ data: { name: "e2e-solana-attested-settle" } }));
  const kase = await prisma.case.create({
    data: {
      organizationId: org.id,
      claim: "Phase 3 acceptance rehearsal — Solana attested_settle() direct payout proof",
      amount: "0.001",
      currency: "SOL",
      policyId: "e2e-attested-settle-rehearsal",
      policyVersion: "v1",
      claimantRef: "e2e-claimant",
      respondentRef: "e2e-respondent",
      settlementChain: "solanatestnet",
      settlementContract: DECISION_RELAY_PROGRAM_ID,
      status: "FINALIZED",
    },
  });
  const decision = await prisma.decision.create({
    data: {
      caseId: kase.id,
      policyId: kase.policyId,
      policyVersion: kase.policyVersion,
      outcome: "RELEASE_FULL",
      claimantShareBps,
      respondentShareBps,
      consensus: "ACCEPTED",
      decisionHash: decisionHash.toString("hex"),
      proofHash: decisionHash.toString("hex"),
      pendingSolanaAttestationMessage: messageHex,
      pendingSolanaAttestations: [],
    },
  });
  console.log(`[e2e] case: ${kase.id}, decision: ${decision.id}`);
  console.log(`[e2e] waiting for a real external signature from the live automated Solana attestor service (up to ${POLL_TIMEOUT_MS / 1000}s)...`);

  const threshold = getSolanaAttestorThreshold();
  const deadlineWaitUntil = Date.now() + POLL_TIMEOUT_MS;
  let externalAttestations: { publicKey: Uint8Array; signature: Uint8Array }[] = [];
  while (Date.now() < deadlineWaitUntil) {
    await sleep(POLL_INTERVAL_MS);
    const refreshed = await prisma.decision.findUniqueOrThrow({ where: { id: decision.id } });
    const records = (refreshed.pendingSolanaAttestations as { publicKey: string; signature: string }[]) ?? [];
    console.log(`[e2e]   ${records.length} external signature(s) collected so far...`);
    if (records.length + 1 >= threshold) {
      externalAttestations = records.map((r) => ({ publicKey: Buffer.from(r.publicKey, "base64"), signature: Buffer.from(r.signature, "base64") }));
      break;
    }
  }

  if (externalAttestations.length + 1 < threshold) {
    throw new Error(
      `Only ${externalAttestations.length + 1}/${threshold} attestor signatures collected after ${POLL_TIMEOUT_MS / 1000}s — the live automated Solana attestor service did not sign in time. ` +
        `Check anc-hor-attestor2/3's own logs; decision ${decision.id} is left in place for manual inspection.`
    );
  }
  console.log(`[e2e] reached ${externalAttestations.length + 1}/${threshold} attestor signatures.`);

  // 3. Submit attested_settle().
  const respondentBalanceBefore = await connection.getBalance(respondent.publicKey);
  console.log(`[e2e] submitting attested_settle()...`);
  const { signature: settlementTxSignature } = await submitAttestedSettle(
    {
      decisionRelayProgramId: DECISION_RELAY_PROGRAM_ID,
      caseId,
      claimant: claimant.publicKey.toBase58(),
      respondent: respondent.publicKey.toBase58(),
      escrowProgram: ESCROW_PROGRAM_ID,
      claimantShareBps,
      respondentShareBps,
      decisionHash,
    },
    RPC_URL,
    externalAttestations
  );
  console.log(`[e2e] attested_settle() tx: ${settlementTxSignature}`);

  await prisma.decision.update({ where: { id: decision.id }, data: { relayTxHash: settlementTxSignature } });

  // 4. Verify.
  const caseStateAfter = await program.account.case.fetch(casePda);
  const vaultBalanceAfter = await connection.getBalance(casePda);
  const respondentBalanceAfter = await connection.getBalance(respondent.publicKey);
  console.log(`[e2e] case status after settle: ${JSON.stringify(caseStateAfter.status)}, vault balance: ${vaultBalanceAfter} lamports`);
  if (!("settled" in caseStateAfter.status)) throw new Error(`case status after settle is ${JSON.stringify(caseStateAfter.status)}, expected Settled`);

  const respondentDelta = respondentBalanceAfter - respondentBalanceBefore;
  const expectedRespondentDelta = Math.floor((DEPOSIT_LAMPORTS.toNumber() * respondentShareBps) / 10000);
  console.log(`[e2e] respondent balance delta: ${respondentDelta} lamports (expected ${expectedRespondentDelta})`);
  if (respondentDelta !== expectedRespondentDelta) throw new Error(`respondent balance delta ${respondentDelta} does not match expected ${expectedRespondentDelta}`);

  // 5. Replay attempt — must fail.
  console.log(`[e2e] attempting replay of attested_settle() with the same decision hash (must fail)...`);
  let replayError: string | null = null;
  try {
    await submitAttestedSettle(
      {
        decisionRelayProgramId: DECISION_RELAY_PROGRAM_ID,
        caseId,
        claimant: claimant.publicKey.toBase58(),
        respondent: respondent.publicKey.toBase58(),
        escrowProgram: ESCROW_PROGRAM_ID,
        claimantShareBps,
        respondentShareBps,
        decisionHash,
      },
      RPC_URL,
      externalAttestations
    );
  } catch (err) {
    replayError = err instanceof Error ? err.message : String(err);
  }
  if (!replayError) throw new Error("replay of attested_settle() with an already-processed decision hash SUCCEEDED — ReplayGuard is broken");
  console.log(`[e2e] replay correctly rejected: ${replayError.slice(0, 300)}`);

  // 6. Proof bundle.
  const write = (name: string, data: unknown) => writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2) + "\n");

  write("case.json", { chain: "solanatestnet", caseId: kase.id, onChainCaseId: caseId, organizationId: org.id, claim: kase.claim, currency: kase.currency, amount: kase.amount, timestamp: nowIso() });
  write("decision.json", { chain: "solanatestnet", decisionId: decision.id, caseId: kase.id, onChainCaseId: caseId, outcome: "RELEASE_FULL", claimantShareBps, respondentShareBps, decisionHash: decisionHash.toString("hex"), timestamp: nowIso() });
  write("attestation-message.json", { chain: "solanatestnet", decisionRelayProgram: DECISION_RELAY_PROGRAM_ID, escrowProgram: ESCROW_PROGRAM_ID, onChainCaseId: caseId, claimant: claimant.publicKey.toBase58(), respondent: respondent.publicKey.toBase58(), claimantShareBps, respondentShareBps, messageHex, hashScheme: "ANCHOR_SOLANA_DECISION_ATTESTATION_V2" });
  write("signatures.json", { chain: "solanatestnet", attestorThreshold: threshold, backendSigner: "decision-relay's own SOLANA_ATTESTOR_PRIVATE_KEY (embedded in the attested_settle transaction's Ed25519 instructions, not separately serialized here)", externalAttestations: externalAttestations.map((a) => ({ publicKey: Buffer.from(a.publicKey).toString("base64"), signature: Buffer.from(a.signature).toString("base64") })) });
  write("deposit-tx.json", { chain: "solanatestnet", program: ESCROW_PROGRAM_ID, depositTxSignature: depositTxSig, timestamp: nowIso() });
  write("settlement-tx.json", { chain: "solanatestnet", program: DECISION_RELAY_PROGRAM_ID, settlementTxSignature, timestamp: nowIso() });
  write("escrow-state-before.json", { chain: "solanatestnet", casePda: casePda.toBase58(), status: caseStateBefore.status, vaultBalanceLamports: vaultBalanceBefore });
  write("escrow-state-after.json", { chain: "solanatestnet", casePda: casePda.toBase58(), status: caseStateAfter.status, vaultBalanceLamports: vaultBalanceAfter });
  write("balance-deltas.json", {
    chain: "solanatestnet",
    respondent: { address: respondent.publicKey.toBase58(), before: respondentBalanceBefore, after: respondentBalanceAfter, delta: respondentDelta, expectedDelta: expectedRespondentDelta, match: respondentDelta === expectedRespondentDelta },
  });
  write("replay-rejection.json", { chain: "solanatestnet", onChainCaseId: caseId, rejected: true, errorMessage: replayError });

  console.log(`\n[e2e] SUCCESS — proof bundle written to ${outDir}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[e2e] FAILED:", err);
  await prisma.$disconnect();
  process.exit(1);
});
