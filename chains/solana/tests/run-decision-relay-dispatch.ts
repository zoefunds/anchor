// Real test against live Solana TESTNET (not devnet — devnet's Hyperlane
// Mailbox exists in the registry but sits in Hyperlane's internal
// "mock-registry" dev environment with no live public relayer; testnet4,
// Hyperlane's actively-relayed environment, pairs Sepolia with Solana
// Testnet specifically — confirmed by checking their monorepo's
// rust/sealevel/environments/testnet4 directory, which lists
// "solanatestnet", not "solanadevnet"). Inits decision-relay, then
// dispatches a CASE_ORIGINATE message via the real testnet Mailbox
// (75HBBLae3ddeneJVrZeyrDfv6vb7SMC3aCpBucSXS5aR) targeting the real
// SolanaCaseReceiver deployed on Sepolia.
//
// Account layout verified against Hyperlane's own
// test-send-receiver/src/test_client.rs, fetched and read in full.
// Run: npx tsx tests/run-decision-relay-dispatch.ts

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
const ESCROW_PROGRAM = new PublicKey("825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn");
const HYPERLANE_MAILBOX_TESTNET = new PublicKey("75HBBLae3ddeneJVrZeyrDfv6vb7SMC3aCpBucSXS5aR");
const SPL_NOOP_PROGRAM = new PublicKey("noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV");
const SEPOLIA_DOMAIN = 11155111;

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path.replace("~", process.env.HOME!), "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function pdaSeeds(seeds: (Buffer | Uint8Array)[], programId: PublicKey): [PublicKey, number] {
  const [pda, bump] = PublicKey.findProgramAddressSync(seeds, programId);
  return [pda, bump];
}

async function main() {
  const connection = new Connection("https://api.testnet.solana.com", "confirmed");
  const payer = loadKeypair("~/.config/solana/id.json");

  console.log(`Payer: ${payer.publicKey.toBase58()}`);
  console.log(`decision-relay: ${DECISION_RELAY_PROGRAM.toBase58()}`);
  console.log(`Hyperlane Mailbox (testnet): ${HYPERLANE_MAILBOX_TESTNET.toBase58()}`);

  const [storagePda] = pdaSeeds(
    [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("storage")],
    DECISION_RELAY_PROGRAM
  );

  // --- 1. Init ---
  console.log("\n1. Init (mailbox + escrow_program)");
  const storageInfo = await connection.getAccountInfo(storagePda);
  if (storageInfo) {
    console.log("  storage PDA already initialized, skipping init");
  } else {
    // borsh: variant index (u8=0) + mailbox (32 bytes) + escrow_program (32 bytes)
    const initData = Buffer.concat([
      Buffer.from([0]),
      HYPERLANE_MAILBOX_TESTNET.toBuffer(),
      ESCROW_PROGRAM.toBuffer(),
    ]);
    const initIx = new TransactionInstruction({
      programId: DECISION_RELAY_PROGRAM,
      keys: [
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: storagePda, isSigner: false, isWritable: true },
      ],
      data: initData,
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(initIx), [payer]);
    console.log(`  ok, tx: ${sig}`);
  }

  // --- 2. Dispatch a CASE_ORIGINATE message via the real Mailbox ---
  console.log("\n2. dispatch_case_originate via live Hyperlane testnet Mailbox");

  const [outboxPda] = pdaSeeds(
    [Buffer.from("hyperlane"), Buffer.from("-"), Buffer.from("outbox")],
    HYPERLANE_MAILBOX_TESTNET
  );
  const [dispatchAuthority] = pdaSeeds(
    [Buffer.from("hyperlane_dispatcher"), Buffer.from("-"), Buffer.from("dispatch_authority")],
    DECISION_RELAY_PROGRAM
  );

  const uniqueMessageAccount = Keypair.generate();
  const [dispatchedMessagePda] = pdaSeeds(
    [Buffer.from("hyperlane"), Buffer.from("-"), Buffer.from("dispatched_message"), Buffer.from("-"), uniqueMessageAccount.publicKey.toBuffer()],
    HYPERLANE_MAILBOX_TESTNET
  );

  // CaseOriginateBody (borsh): case_id (string: u32 LE len + bytes),
  // claimant (32 bytes), respondent (32 bytes), amount_lamports (u64 LE)
  const caseId = `CASE-SOL-${Date.now()}`;
  const caseIdBuf = Buffer.from(caseId, "utf-8");
  const claimant = payer.publicKey;
  const respondent = Keypair.generate().publicKey;
  const amountLamports = Buffer.alloc(8);
  amountLamports.writeBigUInt64LE(10_000_000n); // 0.01 SOL

  const caseOriginateBody = Buffer.concat([
    (() => {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(caseIdBuf.length);
      return len;
    })(),
    caseIdBuf,
    claimant.toBuffer(),
    respondent.toBuffer(),
    amountLamports,
  ]);

  // OutboxDispatch (borsh): sender (32), destination_domain (u32 LE),
  // recipient (H256 = 32 bytes), message_body (u32 LE len + bytes)
  const destinationDomain = Buffer.alloc(4);
  destinationDomain.writeUInt32LE(SEPOLIA_DOMAIN);
  // Real SolanaCaseReceiver deployed on Sepolia — see chains/evm/README
  // and DeploySolanaCaseReceiver.s.sol. EVM address padded to 32 bytes
  // (left-padded with zeros, matching Hyperlane's bytes32 recipient convention).
  const SOLANA_CASE_RECEIVER = "0x76128b04627b80D8E556568cc7fA7cb0eaf035Fe";
  const recipientPlaceholder = Buffer.concat([
    Buffer.alloc(12),
    Buffer.from(SOLANA_CASE_RECEIVER.slice(2), "hex"),
  ]);
  const bodyLen = Buffer.alloc(4);
  bodyLen.writeUInt32LE(caseOriginateBody.length);

  const outboxDispatch = Buffer.concat([
    dispatchAuthority.toBuffer(), // `sender` per Hyperlane's convention — the dispatch authority PDA
    destinationDomain,
    recipientPlaceholder,
    bodyLen,
    caseOriginateBody,
  ]);

  // DecisionRelayInstruction::DispatchCaseOriginate (borsh): variant index (u8=1) + OutboxDispatch
  const dispatchIxData = Buffer.concat([Buffer.from([1]), outboxDispatch]);

  const dispatchIx = new TransactionInstruction({
    programId: DECISION_RELAY_PROGRAM,
    keys: [
      { pubkey: HYPERLANE_MAILBOX_TESTNET, isSigner: false, isWritable: false },
      { pubkey: outboxPda, isSigner: false, isWritable: true },
      { pubkey: dispatchAuthority, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SPL_NOOP_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: uniqueMessageAccount.publicKey, isSigner: true, isWritable: true },
      { pubkey: dispatchedMessagePda, isSigner: false, isWritable: true },
    ],
    data: dispatchIxData,
  });

  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(dispatchIx),
    [payer, uniqueMessageAccount]
  );
  console.log(`  ok, real Hyperlane dispatch tx: ${sig}`);
  console.log(`  case_id: ${caseId}`);
  console.log(`  dispatched message PDA: ${dispatchedMessagePda.toBase58()}`);
  console.log(`\nView on Solana Explorer: https://explorer.solana.com/tx/${sig}?cluster=testnet`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
