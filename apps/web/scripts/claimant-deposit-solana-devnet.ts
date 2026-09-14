// Manual Solana deposit script for the CLAIMANT to run themselves.
//
// Why this exists: the app's wallet-connect deposit UI
// (/public/cases/[id]/deposit) only supports Sepolia today — Solana has
// no equivalent browser wallet-adapter flow yet. Depositing into a
// Solana case's escrow means calling the `escrow` program's
// initializeCase() instruction directly, signed by the claimant's own
// keypair (this script never touches or asks for a private key other
// than the one already in your own local keypair file).
//
// Usage:
//   npx tsx scripts/claimant-deposit-solana-devnet.ts /path/to/your/claimant-keypair.json
//
// If you omit the path, it defaults to ~/.config/solana/id.json (the
// Solana CLI's default keypair) — only use that default if that really
// is the claimant's own wallet (J8vrekxKUVvpc7FVj6nNdsa9XqQwEwfzWXn6LQm1speE
// for this specific case).
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Connection } from "@solana/web3.js";
import { readFileSync } from "fs";
import path from "path";
import os from "os";
import { confirmTransactionBounded } from "../src/lib/solana-confirm";

const RPC_URL = "https://api.devnet.solana.com";
const DECISION_RELAY_PROGRAM_ID = "DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN";
const ESCROW_PROGRAM_ID = "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn";

// Exact values matching the real case already registered in the app —
// see CaseSettlement for cmu0w0m3u0002g9fzeyahl6he (escrowId ==
// on-chain case_id, expectedAmountAtto == lamports for a SOL escrow).
const CASE_ID = "sol-devnet-test-1";
const RESPONDENT = "65MLJPGBdjWNXBKfoc7f3xtB5tskhjLs9RMoz9nbXm8m";
const DEPOSIT_LAMPORTS = new anchor.BN(20_000_000); // 0.02 SOL

async function main() {
  const keypairPath = process.argv[2] ?? path.join(os.homedir(), ".config/solana/id.json");
  const secretKey = Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf-8")));
  const claimant = Keypair.fromSecretKey(secretKey);

  const connection = new Connection(RPC_URL, "confirmed");
  const decisionRelayProgramId = new PublicKey(DECISION_RELAY_PROGRAM_ID);
  const escrowProgramId = new PublicKey(ESCROW_PROGRAM_ID);
  const respondent = new PublicKey(RESPONDENT);

  // decision-relay's own CPI signer into escrow.settle() later — the
  // escrow program's `adjudicator` field must be set to THIS PDA, not
  // a human/org key, or attested_settle's later CPI fails escrow's own
  // `adjudicator == case.adjudicator` check.
  const [escrowAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("escrow_authority")],
    decisionRelayProgramId
  );

  const [casePda] = PublicKey.findProgramAddressSync([Buffer.from("case"), Buffer.from(CASE_ID)], escrowProgramId);

  console.log(`claimant: ${claimant.publicKey.toBase58()}`);
  console.log(`case PDA: ${casePda.toBase58()}`);
  console.log(`depositing ${DEPOSIT_LAMPORTS.toNumber() / 1e9} SOL...`);

  const balance = await connection.getBalance(claimant.publicKey);
  if (balance < DEPOSIT_LAMPORTS.toNumber() + 0.01e9) {
    throw new Error(
      `balance too low (${balance / 1e9} SOL) for a ${DEPOSIT_LAMPORTS.toNumber() / 1e9} SOL deposit plus fees — ` +
        `fund ${claimant.publicKey.toBase58()} via https://faucet.solana.com (select Devnet)`
    );
  }

  const idl = JSON.parse(readFileSync(path.resolve(__dirname, "../../../chains/solana/target/idl/escrow.json"), "utf-8"));
  const provider = new anchor.AnchorProvider(
    connection,
    {
      publicKey: claimant.publicKey,
      signTransaction: async (tx: any) => {
        tx.sign(claimant);
        return tx;
      },
      signAllTransactions: async (txs: any[]) => {
        txs.forEach((tx) => tx.sign(claimant));
        return txs;
      },
    } as anchor.Wallet,
    { commitment: "confirmed" }
  );
  const program = new (anchor as any).Program(idl, provider);

  const depositIx = await program.methods
    .initializeCase(CASE_ID, respondent, escrowAuthorityPda, DEPOSIT_LAMPORTS)
    .accounts({ claimant: claimant.publicKey, case: casePda, systemProgram: SystemProgram.programId })
    .instruction();

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new anchor.web3.Transaction({ recentBlockhash: blockhash, feePayer: claimant.publicKey }).add(depositIx);
  tx.sign(claimant);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await confirmTransactionBounded({ connection, signature: sig, lastValidBlockHeight, commitment: "confirmed" });

  console.log(`deposit confirmed: ${sig}`);
  console.log(`https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  console.log(`The app will pick this up automatically on its next deposit-check sweep, or click "sync now" on the case page.`);
}

main().catch((err) => {
  console.error("FAILED:", err.message ?? err);
  process.exit(1);
});
