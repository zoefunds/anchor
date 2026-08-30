// Creates a real escrow case on Solana Testnet with decision-relay's
// escrow-authority PDA as the adjudicator, so a real inbound
// DecisionRelay Hyperlane message can genuinely CPI into escrow.settle()
// — proving the full round trip (EVM dispatch -> Solana handle() ->
// escrow.settle()), not just that a message was dispatched.
// Run: npx tsx tests/run-create-case-for-relay-test.ts

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "fs";

async function main() {
  process.env.ANCHOR_PROVIDER_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.testnet.solana.com";
  process.env.ANCHOR_WALLET = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idl = JSON.parse(readFileSync(new URL("../target/idl/escrow.json", import.meta.url), "utf-8"));
  const program = new (anchor as any).Program(idl, provider);

  const DECISION_RELAY = new PublicKey("DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN");
  const [escrowAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("escrow_authority")],
    DECISION_RELAY
  );

  const claimant = provider.wallet as anchor.Wallet;
  const respondent = Keypair.generate();
  const caseId = process.argv[2] ?? `CASE-RELAY-${Date.now()}`;
  const amountLamports = new anchor.BN(0.01 * LAMPORTS_PER_SOL);

  const [casePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("case"), Buffer.from(caseId)],
    program.programId
  );

  console.log(`Program: ${program.programId.toBase58()}`);
  console.log(`decision-relay escrow-authority PDA (adjudicator): ${escrowAuthority.toBase58()}`);
  console.log(`Case: ${caseId} -> PDA ${casePda.toBase58()}`);
  console.log(`Claimant: ${claimant.publicKey.toBase58()}`);
  console.log(`Respondent: ${respondent.publicKey.toBase58()}`);

  await program.methods
    .initializeCase(caseId, respondent.publicKey, escrowAuthority, amountLamports)
    .accounts({ claimant: claimant.publicKey, case: casePda, systemProgram: SystemProgram.programId })
    .rpc();
  console.log("\ninitialize_case ok");

  await program.methods
    .raiseDispute()
    .accounts({ signer: claimant.publicKey, case: casePda })
    .rpc();
  console.log("raise_dispute ok — case is ready for decision-relay to settle it");

  console.log(`\nCASE_ID=${caseId}`);
  console.log(`CLAIMANT=${claimant.publicKey.toBase58()}`);
  console.log(`RESPONDENT=${respondent.publicKey.toBase58()}`);
  console.log(`ESCROW_PROGRAM=${program.programId.toBase58()}`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
