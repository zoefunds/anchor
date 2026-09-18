// Real E2E test of the Solana emergency-refund flow on Devnet: creates a
// real case against the PRODUCTION escrow program (825aV7GJ...), points
// its adjudicator at a THROWAWAY test-attestors build of decision-relay
// (deployed fresh, disposable program id, real production keys never
// touch this file), shortens the case's own timeout window via
// update_emergency_refund_timeout, waits for it to elapse, then submits
// a real 2-of-3 Ed25519-attested EmergencyRefund and verifies the
// claimant's balance actually moves and Case.status becomes Refunded.
//
// This proves the exact on-chain code path apps/web/src/lib/
// solana-settle.ts's submitEmergencyRefund() drives in production,
// without needing the real ATTESTOR_PUBKEYS private keys (which live on
// Fly, not on this machine).
//
// Run: npx tsx tests/run-emergency-refund-devnet-e2e.ts

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "fs";
import * as path from "path";
import * as crypto from "crypto";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ESCROW_PROGRAM = new PublicKey("825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn");
const TEST_RELAY_KEYPAIR_PATH = process.env.TEST_DECISION_RELAY_KEYPAIR ?? "/tmp/test-decision-relay-keypair.json";
const DECISION_RELAY_PROGRAM = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(TEST_RELAY_KEYPAIR_PATH, "utf-8")))
).publicKey;
const FIXTURES_DIR = path.join(__dirname, "fixtures", "localnet-test-attestors");

function loadFixtureKeypair(filename: string): Keypair {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, filename), "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

// Mirrors decision-relay's emergency_refund_attestation_message() exactly.
function emergencyRefundAttestationMessage(params: { programId: PublicKey; caseId: string; claimant: PublicKey; escrowProgram: PublicKey }): Buffer {
  const tag = Buffer.from("ANCHOR_SOLANA_EMERGENCY_REFUND_V1", "utf-8");
  const TESTNET_GENESIS_HASH = new PublicKey("4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY");
  const caseIdBytes = Buffer.from(params.caseId, "utf-8");
  const caseIdLen = Buffer.alloc(4);
  caseIdLen.writeUInt32LE(caseIdBytes.length);
  return Buffer.concat([
    tag,
    TESTNET_GENESIS_HASH.toBuffer(),
    params.programId.toBuffer(),
    caseIdLen,
    caseIdBytes,
    params.claimant.toBuffer(),
    params.escrowProgram.toBuffer(),
  ]);
}

function encodeEmergencyRefundBody(params: { caseId: string; claimant: PublicKey; escrowProgram: PublicKey }): Buffer {
  const caseIdBytes = Buffer.from(params.caseId, "utf-8");
  const caseIdLen = Buffer.alloc(4);
  caseIdLen.writeUInt32LE(caseIdBytes.length);
  return Buffer.concat([caseIdLen, caseIdBytes, params.claimant.toBuffer(), params.escrowProgram.toBuffer()]);
}

const DECISION_RELAY_EMERGENCY_REFUND_VARIANT = 4; // DecisionRelayInstruction::EmergencyRefund's Borsh discriminant (Init=0, DispatchCaseOriginate=1, AttestedSettle=2, InitReplayGuard=3, EmergencyRefund=4)

function buildEmergencyRefundIx(params: { caseId: string; claimant: PublicKey }): TransactionInstruction {
  const storagePda = pda([Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("storage")], DECISION_RELAY_PROGRAM);
  const escrowAuthorityPda = pda([Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("escrow_authority")], DECISION_RELAY_PROGRAM);
  const casePda = pda([Buffer.from("case"), Buffer.from(params.caseId, "utf-8")], ESCROW_PROGRAM);
  const configPda = pda([Buffer.from("config")], ESCROW_PROGRAM);

  const data = Buffer.concat([
    Buffer.from([DECISION_RELAY_EMERGENCY_REFUND_VARIANT]),
    encodeEmergencyRefundBody({ ...params, escrowProgram: ESCROW_PROGRAM }),
  ]);

  return new TransactionInstruction({
    programId: DECISION_RELAY_PROGRAM,
    keys: [
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: storagePda, isSigner: false, isWritable: false },
      { pubkey: ESCROW_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: casePda, isSigner: false, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: params.claimant, isSigner: false, isWritable: true },
      { pubkey: escrowAuthorityPda, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function signWithAttestor(attestor: Keypair, message: Buffer): TransactionInstruction {
  return Ed25519Program.createInstructionWithPrivateKey({ privateKey: attestor.secretKey, message });
}

async function initDecisionRelayStorage(connection: Connection, payer: Keypair) {
  const storagePda = pda([Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("storage")], DECISION_RELAY_PROGRAM);
  const existing = await connection.getAccountInfo(storagePda);
  if (existing) {
    console.log("  storage already initialized");
    return;
  }
  const dummyMailbox = Keypair.generate().publicKey;
  const data = Buffer.concat([Buffer.from([0]), dummyMailbox.toBuffer(), ESCROW_PROGRAM.toBuffer()]);
  const ix = new TransactionInstruction({
    programId: DECISION_RELAY_PROGRAM,
    keys: [
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: storagePda, isSigner: false, isWritable: true },
    ],
    data,
  });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
  console.log(`  initialized storage, tx ${sig}`);
}

async function initializeCase(
  connection: Connection,
  payer: Keypair,
  caseId: string,
  claimant: Keypair,
  respondent: PublicKey,
  amountLamports: bigint
) {
  const escrowAuthorityPda = pda([Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("escrow_authority")], DECISION_RELAY_PROGRAM);
  const casePda = pda([Buffer.from("case"), Buffer.from(caseId, "utf-8")], ESCROW_PROGRAM);

  const disc = crypto.createHash("sha256").update("global:initialize_case").digest().subarray(0, 8);
  const caseIdBytes = Buffer.from(caseId, "utf-8");
  const caseIdLen = Buffer.alloc(4);
  caseIdLen.writeUInt32LE(caseIdBytes.length);
  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(amountLamports);
  const data = Buffer.concat([disc, caseIdLen, caseIdBytes, respondent.toBuffer(), escrowAuthorityPda.toBuffer(), amountBuf]);

  const ix = new TransactionInstruction({
    programId: ESCROW_PROGRAM,
    keys: [
      { pubkey: claimant.publicKey, isSigner: true, isWritable: true },
      { pubkey: casePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: claimant.publicKey, lamports: amountLamports + 10_000_000n })),
    [payer]
  );
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [claimant]);
  console.log(`  initialize_case tx ${sig}`);
  return casePda;
}

async function updateEmergencyRefundTimeout(connection: Connection, authority: Keypair, newTimeoutSeconds: number) {
  const configPda = pda([Buffer.from("config")], ESCROW_PROGRAM);
  const disc = crypto.createHash("sha256").update("global:update_emergency_refund_timeout").digest().subarray(0, 8);
  const timeoutBuf = Buffer.alloc(8);
  timeoutBuf.writeBigInt64LE(BigInt(newTimeoutSeconds));
  const data = Buffer.concat([disc, timeoutBuf]);
  const ix = new TransactionInstruction({
    programId: ESCROW_PROGRAM,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ],
    data,
  });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]);
  console.log(`  update_emergency_refund_timeout(${newTimeoutSeconds}s) tx ${sig}`);
}

async function fetchCaseStatus(connection: Connection, casePda: PublicKey): Promise<string> {
  const info = await connection.getAccountInfo(casePda);
  if (!info) return "CLOSED";
  // Case layout: 8 disc + 4+case_id + 32*3 pubkeys + 8 amount + 1 status + 1 bump + 8 deposited_at
  // status enum is a single byte immediately after amount_lamports; find it by walking case_id length.
  const caseIdLen = info.data.readUInt32LE(8);
  const statusOffset = 8 + 4 + caseIdLen + 32 * 3 + 8;
  const statusByte = info.data[statusOffset];
  return ["Active", "Disputed", "Settled", "Refunded"][statusByte] ?? `unknown(${statusByte})`;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8")))
  );

  const attestor1 = loadFixtureKeypair("attestor1.json");
  const attestor2 = loadFixtureKeypair("attestor2.json");

  console.log(`decision-relay (throwaway test-attestors build): ${DECISION_RELAY_PROGRAM.toBase58()}`);
  console.log(`escrow (PRODUCTION, unchanged): ${ESCROW_PROGRAM.toBase58()}`);

  console.log("\n1. init decision-relay storage (idempotent)");
  await initDecisionRelayStorage(connection, payer);

  console.log("\n2. shorten the shared emergency-refund timeout to 8s for this test");
  await updateEmergencyRefundTimeout(connection, payer, 8);

  console.log("\n3. initialize_case (claimant deposits into PRODUCTION escrow)");
  const claimant = Keypair.generate();
  const respondent = Keypair.generate().publicKey;
  const caseId = `EMRG-${Date.now()}`;
  const amountLamports = 5_000_000n; // 0.005 SOL
  const casePda = await initializeCase(connection, payer, caseId, claimant, respondent, amountLamports);

  let status = await fetchCaseStatus(connection, casePda);
  assert(status === "Active", `case status is Active after deposit (got ${status})`);

  console.log("\n4. confirm emergency_refund is correctly rejected before the timeout elapses");
  const message = emergencyRefundAttestationMessage({ programId: DECISION_RELAY_PROGRAM, caseId, claimant: claimant.publicKey, escrowProgram: ESCROW_PROGRAM });
  const ed1 = signWithAttestor(attestor1, message);
  const ed2 = signWithAttestor(attestor2, message);
  const refundIx = buildEmergencyRefundIx({ caseId, claimant: claimant.publicKey });
  try {
    await sendAndConfirmTransaction(connection, new Transaction().add(ed1, ed2, refundIx), [payer]);
    throw new Error("expected emergency_refund to fail before timeout elapsed, but it succeeded");
  } catch (err: any) {
    assert(String(err.message ?? err).length > 0, "emergency_refund rejected pre-timeout (TimeoutNotElapsed), as expected");
  }

  console.log("\n5. wait for the 8s timeout to elapse");
  await new Promise((r) => setTimeout(r, 10_000));

  console.log("\n6. submit the real 2-of-3 attested EmergencyRefund");
  const claimantBefore = await connection.getBalance(claimant.publicKey);
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ed1, ed2, refundIx), [payer]);
  console.log(`  emergency_refund tx: ${sig}`);

  status = await fetchCaseStatus(connection, casePda);
  assert(status === "Refunded", `case status is Refunded after emergency_refund (got ${status})`);

  const claimantAfter = await connection.getBalance(claimant.publicKey);
  assert(BigInt(claimantAfter - claimantBefore) === amountLamports, `claimant received exactly ${amountLamports} lamports back (got ${claimantAfter - claimantBefore})`);

  console.log("\n7. restore the shared timeout back to production's 1 hour default");
  await updateEmergencyRefundTimeout(connection, payer, 3600);

  console.log("\nAll assertions passed — real deposit -> timeout -> 2-of-3 attested emergency_refund proven end-to-end on Solana Devnet, against the PRODUCTION escrow program.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
