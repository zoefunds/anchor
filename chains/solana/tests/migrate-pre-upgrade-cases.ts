// One-time migration: extends the two real Devnet Case accounts created
// before the 2026-09-18 escrow upgrade added `deposited_at` (Case-2,
// CASE-RELAY-2 — see docs/incidents/ for the finding) to the current
// account size and backfills `deposited_at` from Postgres's own
// CaseSettlement.depositConfirmedAt, the closest real record of when
// each deposit actually happened. Required before either case can ever
// succeed a real emergency_refund call — see escrow's own
// migrate_case_deposited_at doc comment for why Anchor can't just
// deserialize (and therefore can't realloc) a too-short pre-upgrade
// account without this raw-bytes workaround.
//
// PREREQUISITE: the escrow program upgrade adding migrate_case_deposited_at
// must already be deployed (chains/solana/target/deploy/escrow.so, same
// program id 825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn) — this script
// does not deploy it.
//
// Run: npx tsx tests/migrate-pre-upgrade-cases.ts

import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "fs";
import * as crypto from "crypto";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const ESCROW_PROGRAM = new PublicKey("825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn");

// caseId -> real deposit-confirmation time, from Postgres's own
// CaseSettlement.depositConfirmedAt (queried directly, not guessed):
//   Case-2         -> 2026-09-16T11:53:50.707Z
//   CASE-RELAY-2   -> 2026-09-18T07:47:54.721Z
const MIGRATIONS: { caseId: string; depositedAtIso: string }[] = [
  { caseId: "Case-2", depositedAtIso: "2026-09-16T11:53:50.707Z" },
  { caseId: "CASE-RELAY-2", depositedAtIso: "2026-09-18T07:47:54.721Z" },
];

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

async function migrateCaseDepositedAt(connection: Connection, authority: Keypair, caseId: string, depositedAtSeconds: bigint) {
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
  console.log(`  migrated ${caseId} (case PDA ${casePda.toBase58()}), tx ${sig}`);
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const authority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8")))
  );

  for (const { caseId, depositedAtIso } of MIGRATIONS) {
    const casePda = pda([Buffer.from("case"), Buffer.from(caseId, "utf-8")], ESCROW_PROGRAM);
    const info = await connection.getAccountInfo(casePda);
    if (!info) {
      console.log(`${caseId}: account not found, skipping`);
      continue;
    }
    if (info.data.length >= 190) {
      console.log(`${caseId}: already migrated (${info.data.length} bytes), skipping`);
      continue;
    }
    const depositedAtSeconds = BigInt(Math.floor(new Date(depositedAtIso).getTime() / 1000));
    console.log(`${caseId}: migrating (${info.data.length} -> 190 bytes), deposited_at=${depositedAtIso} (${depositedAtSeconds}s)`);
    await migrateCaseDepositedAt(connection, authority, caseId, depositedAtSeconds);

    const after = await connection.getAccountInfo(casePda);
    console.log(`  new size: ${after?.data.length} bytes`);
  }

  console.log("\nDone. Each migrated case is now eligible for emergency_refund once config.emergency_refund_timeout_seconds has elapsed since its deposited_at above.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
