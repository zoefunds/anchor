// Real end-to-end lifecycle test against live Solana devnet: deposit,
// dispute, settle with a bps split matching Anchor's decision schema.
// Plain script (not mocha) because ts-mocha/yargs breaks under Node 26's
// stricter ESM/CJS interop. Run: npx tsx tests/run-escrow-e2e.ts

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "fs";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  process.env.ANCHOR_PROVIDER_URL = process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";
  process.env.ANCHOR_WALLET = process.env.ANCHOR_WALLET ?? `${process.env.HOME}/.config/solana/id.json`;

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const idl = JSON.parse(readFileSync(new URL("../target/idl/escrow.json", import.meta.url), "utf-8"));
  const program = new (anchor as any).Program(idl, provider);

  const claimant = provider.wallet as anchor.Wallet;
  const respondent = Keypair.generate();
  const adjudicator = Keypair.generate();

  const caseId = `CASE-${Date.now()}`;
  const amountLamports = new anchor.BN(0.01 * LAMPORTS_PER_SOL);

  const [casePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("case"), Buffer.from(caseId)],
    program.programId
  );

  console.log(`Program: ${program.programId.toBase58()}`);
  console.log(`Case: ${caseId} -> PDA ${casePda.toBase58()}`);

  console.log("\n1. initialize_case (deposit)");
  await program.methods
    .initializeCase(caseId, respondent.publicKey, adjudicator.publicKey, amountLamports)
    .accounts({ claimant: claimant.publicKey, case: casePda, systemProgram: SystemProgram.programId })
    .rpc();

  let caseAccount: any = await program.account.case.fetch(casePda);
  assert(caseAccount.caseId === caseId, "case_id matches");
  assert(caseAccount.amountLamports.toString() === amountLamports.toString(), "amount matches");
  assert("active" in caseAccount.status, "status is Active");
  const vaultBalance = await provider.connection.getBalance(casePda);
  assert(vaultBalance >= amountLamports.toNumber(), "vault holds the deposited amount");

  console.log("\n2. raise_dispute");
  await program.methods
    .raiseDispute()
    .accounts({ signer: claimant.publicKey, case: casePda })
    .rpc();
  caseAccount = await program.account.case.fetch(casePda);
  assert("disputed" in caseAccount.status, "status is Disputed");

  console.log("\n3. settle (65/35 split, matching a GenLayer REFUND_PARTIAL decision)");
  // Fund the adjudicator from our own already-funded wallet rather than the
  // devnet airdrop faucet, which is rate-limited independent of our balance.
  const fundTx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: claimant.publicKey,
      toPubkey: adjudicator.publicKey,
      lamports: 0.01 * LAMPORTS_PER_SOL,
    })
  );
  await provider.sendAndConfirm(fundTx);

  const respondentBefore = await provider.connection.getBalance(respondent.publicKey);
  const claimantBefore = await provider.connection.getBalance(claimant.publicKey);

  await program.methods
    .settle(6500, 3500)
    .accounts({
      adjudicator: adjudicator.publicKey,
      case: casePda,
      claimant: claimant.publicKey,
      respondent: respondent.publicKey,
    })
    .signers([adjudicator])
    .rpc();

  caseAccount = await program.account.case.fetch(casePda);
  assert("settled" in caseAccount.status, "status is Settled");

  const respondentAfter = await provider.connection.getBalance(respondent.publicKey);
  const claimantAfter = await provider.connection.getBalance(claimant.publicKey);

  const expectedClaimant = Math.floor((amountLamports.toNumber() * 6500) / 10000);
  const expectedRespondent = amountLamports.toNumber() - expectedClaimant;

  assert(respondentAfter - respondentBefore === expectedRespondent, `respondent received exactly ${expectedRespondent} lamports (35%)`);
  // Claimant is the tx fee payer and the settle instruction requires 2
  // signatures (claimant + adjudicator) — Solana's base fee is 5000
  // lamports per required signature, so exactly 10,000 lamports comes out
  // of the claimant's share here. Not a tolerance fudge — the exact fee.
  const settleTxFee = 10_000;
  assert(
    claimantAfter - claimantBefore === expectedClaimant - settleTxFee,
    `claimant received exactly ${expectedClaimant - settleTxFee} lamports (65% minus the settle tx fee)`
  );

  console.log("\nAll assertions passed — real deposit -> dispute -> settle lifecycle proven on Solana devnet.");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
