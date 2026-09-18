// Corrects the two Case accounts (Case-2, CASE-RELAY-2) that
// tests/migrate-pre-upgrade-cases.ts already ran against BEFORE
// migrate_case_deposited_at's offset bug was found and fixed (see that
// instruction's own doc comment in programs/escrow/src/lib.rs for the
// full story): the first run wrote deposited_at to the tail of the
// account's physical buffer instead of its real Borsh offset
// (immediately after `bump`), so Anchor's own deserialization still
// reads deposited_at as 0 for both. The corrected instruction only
// requires the REAL offset's 8 bytes to currently be zero, which they
// still are (the first run never touched them) — so this is safe to run
// once against the already-realloc'd 190-byte accounts; it does not
// re-realloc or touch anything else.
//
// PREREQUISITE: the corrected escrow.so (with the offset fix) must
// already be deployed to program id 825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn
// before running this.
//
// Run: npx tsx tests/fix-migrated-case-deposited-at.ts

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";
import * as crypto from "crypto";
import * as anchor from "@coral-xyz/anchor";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ESCROW_PROGRAM = new PublicKey("825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn");

const FIXES: { caseId: string; depositedAtIso: string }[] = [
  { caseId: "Case-2", depositedAtIso: "2026-09-16T11:53:50.707Z" },
  { caseId: "CASE-RELAY-2", depositedAtIso: "2026-09-18T07:47:54.721Z" },
];

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

async function fixCase(connection: Connection, authority: Keypair, caseId: string, depositedAtSeconds: bigint) {
  const configPda = pda([Buffer.from("config")], ESCROW_PROGRAM);
  const casePda = pda([Buffer.from("case"), Buffer.from(caseId, "utf-8")], ESCROW_PROGRAM);

  const disc = crypto.createHash("sha256").update("global:migrate_case_deposited_at").digest().subarray(0, 8);
  const caseIdBytes = Buffer.from(caseId, "utf-8");
  const caseIdLen = Buffer.alloc(4);
  caseIdLen.writeUInt32LE(caseIdBytes.length);
  const depositedAtBuf = Buffer.alloc(8);
  depositedAtBuf.writeBigInt64LE(depositedAtSeconds);
  const data = Buffer.concat([disc, caseIdLen, caseIdBytes, depositedAtBuf]);

  const ix = new TransactionInstruction({
    programId: ESCROW_PROGRAM,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: false },
      { pubkey: casePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority]);
  console.log(`  fixed ${caseId} (case PDA ${casePda.toBase58()}), tx ${sig}`);
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const authority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8")))
  );
  const idl = JSON.parse(readFileSync(new URL("../target/idl/escrow.json", import.meta.url), "utf-8"));
  const coder = new (anchor as any).BorshAccountsCoder(idl);

  for (const { caseId, depositedAtIso } of FIXES) {
    const casePda = pda([Buffer.from("case"), Buffer.from(caseId, "utf-8")], ESCROW_PROGRAM);
    const before = await connection.getAccountInfo(casePda);
    if (!before) {
      console.log(`${caseId}: account not found, skipping`);
      continue;
    }
    const decodedBefore = coder.decode("Case", before.data);
    const currentDepositedAt = (decodedBefore.deposited_at ?? decodedBefore.depositedAt).toString();
    if (currentDepositedAt !== "0") {
      console.log(`${caseId}: deposited_at already ${currentDepositedAt}, skipping (already correct)`);
      continue;
    }
    const depositedAtSeconds = BigInt(Math.floor(new Date(depositedAtIso).getTime() / 1000));
    console.log(`${caseId}: writing deposited_at=${depositedAtIso} (${depositedAtSeconds}s) at its real Borsh offset`);
    await fixCase(connection, authority, caseId, depositedAtSeconds);

    const after = await connection.getAccountInfo(casePda);
    const decodedAfter = coder.decode("Case", after!.data);
    const nowDepositedAt = (decodedAfter.deposited_at ?? decodedAfter.depositedAt).toString();
    console.log(`  verified via Anchor decode: deposited_at now reads ${nowDepositedAt}`);
    if (nowDepositedAt !== depositedAtSeconds.toString()) {
      throw new Error(`${caseId}: post-fix decode mismatch — expected ${depositedAtSeconds}, got ${nowDepositedAt}`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
