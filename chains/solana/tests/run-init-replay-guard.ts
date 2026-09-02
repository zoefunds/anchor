// One-time setup: allocates decision-relay's fixed ReplayGuard PDA on
// Solana Testnet. See lib.rs's ReplayGuard/init_replay_guard doc
// comments and chains/solana/REPLAYGUARD_DEPLOYMENT.md for the full
// context. Run: npx tsx tests/run-init-replay-guard.ts

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "fs";

const DECISION_RELAY_PROGRAM = new PublicKey("DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN");

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path.replace("~", process.env.HOME!), "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const connection = new Connection("https://api.testnet.solana.com", "confirmed");
  const payer = loadKeypair("~/.config/solana/id.json");

  const [replayGuardPda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("replay_guard")],
    DECISION_RELAY_PROGRAM
  );
  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  console.log(`decision-relay: ${DECISION_RELAY_PROGRAM.toBase58()}`);
  console.log(`ReplayGuard PDA: ${replayGuardPda.toBase58()} (bump ${bump})`);

  const existing = await connection.getAccountInfo(replayGuardPda);
  if (existing) {
    console.log(`  already initialized: owner=${existing.owner.toBase58()} size=${existing.data.length} lamports=${existing.lamports}`);
    return;
  }

  // Borsh: unit enum variant InitReplayGuard is index 3 (Init=0,
  // DispatchCaseOriginate=1, AttestedSettle=2, InitReplayGuard=3), no
  // associated data.
  const initReplayGuardData = Buffer.from([3]);
  const ix = new TransactionInstruction({
    programId: DECISION_RELAY_PROGRAM,
    keys: [
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: replayGuardPda, isSigner: false, isWritable: true },
    ],
    data: initReplayGuardData,
  });

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
  console.log(`InitReplayGuard tx: ${sig}`);

  const after = await connection.getAccountInfo(replayGuardPda);
  console.log(`Post-init account: owner=${after?.owner.toBase58()} size=${after?.data.length} lamports=${after?.lamports}`);
  if (after) {
    // ReplayGuard: seen [[u8;32]; 32] (1024 bytes) + next_index (u8) = 1025 bytes
    const nextIndex = after.data[1024];
    const allZero = after.data.subarray(0, 1024).every((b) => b === 0);
    console.log(`next_index: ${nextIndex} (expect 0)`);
    console.log(`seen all-zero: ${allZero} (expect true)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
