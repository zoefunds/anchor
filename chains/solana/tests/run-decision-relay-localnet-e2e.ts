// Real E2E test of decision-relay's `attested_settle` Ed25519/quorum
// logic against a local `solana-test-validator` — see
// chains/solana/tests/README-localnet-tests.md for the full setup this
// depends on (feature-gated ATTESTOR_PUBKEYS, throwaway keys under
// fixtures/localnet-test-attestors/, localnet program deploy).
//
// This can NEVER run against the real deployed decision-relay program:
// it needs 2-of-3 real signatures from ATTESTOR_PUBKEYS, and the
// program built for this test has those consts swapped for throwaway
// keys via the `test-attestors` Cargo feature (chains/solana/programs/
// decision-relay/Cargo.toml) — production keys never touch this file.
//
// Run: npx tsx tests/run-decision-relay-localnet-e2e.ts
// Prereqs: solana-test-validator running on 127.0.0.1:8899, escrow.so
// and the test-attestors build of decision_relay.so deployed there
// (see the README for exact commands), LOCALNET_DECISION_RELAY_PROGRAM
// and LOCALNET_PAYER env vars set accordingly.

import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "fs";
import * as path from "path";
import * as assert from "assert";

const RPC_URL = process.env.LOCALNET_RPC_URL ?? "http://127.0.0.1:8899";
const ESCROW_PROGRAM = new PublicKey(process.env.LOCALNET_ESCROW_PROGRAM ?? "825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn");
const DECISION_RELAY_PROGRAM = new PublicKey(
  process.env.LOCALNET_DECISION_RELAY_PROGRAM ?? mustReadLocalDeployPubkey()
);

const FIXTURES_DIR = path.join(__dirname, "fixtures", "localnet-test-attestors");
const TESTNET_GENESIS_HASH = new PublicKey("4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"); // compile-time tag only, not runtime-checked — must match decision_attestation_message's constant regardless of which cluster this validator is

function mustReadLocalDeployPubkey(): string {
  const raw = JSON.parse(
    readFileSync(path.join(__dirname, "..", "target", "deploy-test-attestors", "decision_relay_localnet-keypair.json"), "utf-8")
  );
  return Keypair.fromSecretKey(Uint8Array.from(raw)).publicKey.toBase58();
}

function loadFixtureKeypair(filename: string): Keypair {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, filename), "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function pda(seeds: (Buffer | Uint8Array)[], programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

function casePdaFor(caseId: string): PublicKey {
  return pda([Buffer.from("case"), Buffer.from(caseId, "utf-8")], ESCROW_PROGRAM);
}

// Mirrors decision-relay's Rust decision_attestation_message() exactly
// (chains/solana/programs/decision-relay/src/lib.rs) and apps/web/src/
// lib/solana-settle.ts's decisionAttestationMessage() — all three MUST
// stay byte-identical or every signature this builds fails on-chain.
function decisionAttestationMessage(params: {
  programId: PublicKey;
  caseId: string;
  claimant: PublicKey;
  respondent: PublicKey;
  escrowProgram: PublicKey;
  claimantShareBps: number;
  respondentShareBps: number;
  decisionHash: Buffer;
}): Buffer {
  const tag = Buffer.from("ANCHOR_SOLANA_DECISION_ATTESTATION_V2", "utf-8");
  const caseIdBytes = Buffer.from(params.caseId, "utf-8");
  const caseIdLen = Buffer.alloc(4);
  caseIdLen.writeUInt32LE(caseIdBytes.length);
  const claimantShareBps = Buffer.alloc(2);
  claimantShareBps.writeUInt16LE(params.claimantShareBps);
  const respondentShareBps = Buffer.alloc(2);
  respondentShareBps.writeUInt16LE(params.respondentShareBps);
  return Buffer.concat([
    tag,
    TESTNET_GENESIS_HASH.toBuffer(),
    params.programId.toBuffer(),
    caseIdLen,
    caseIdBytes,
    params.claimant.toBuffer(),
    params.respondent.toBuffer(),
    params.escrowProgram.toBuffer(),
    claimantShareBps,
    respondentShareBps,
    params.decisionHash,
  ]);
}

function encodeDecisionRelayBody(params: {
  caseId: string;
  claimant: PublicKey;
  respondent: PublicKey;
  escrowProgram: PublicKey;
  claimantShareBps: number;
  respondentShareBps: number;
  decisionHash: Buffer;
}): Buffer {
  const caseIdBytes = Buffer.from(params.caseId, "utf-8");
  const caseIdLen = Buffer.alloc(4);
  caseIdLen.writeUInt32LE(caseIdBytes.length);
  const claimantShareBps = Buffer.alloc(2);
  claimantShareBps.writeUInt16LE(params.claimantShareBps);
  const respondentShareBps = Buffer.alloc(2);
  respondentShareBps.writeUInt16LE(params.respondentShareBps);
  return Buffer.concat([
    caseIdLen,
    caseIdBytes,
    params.claimant.toBuffer(),
    params.respondent.toBuffer(),
    params.escrowProgram.toBuffer(),
    claimantShareBps,
    respondentShareBps,
    params.decisionHash,
  ]);
}

const DECISION_RELAY_ATTESTED_SETTLE_VARIANT = 2; // DecisionRelayInstruction::AttestedSettle's Borsh discriminant

function buildAttestedSettleIx(params: {
  caseId: string;
  claimant: PublicKey;
  respondent: PublicKey;
  claimantShareBps: number;
  respondentShareBps: number;
  decisionHash: Buffer;
}): TransactionInstruction {
  const storagePda = pda([Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("storage")], DECISION_RELAY_PROGRAM);
  const escrowAuthorityPda = pda(
    [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("escrow_authority")],
    DECISION_RELAY_PROGRAM
  );
  const casePda = pda([Buffer.from("case"), Buffer.from(params.caseId, "utf-8")], ESCROW_PROGRAM);

  const data = Buffer.concat([
    Buffer.from([DECISION_RELAY_ATTESTED_SETTLE_VARIANT]),
    encodeDecisionRelayBody({ ...params, escrowProgram: ESCROW_PROGRAM }),
  ]);

  return new TransactionInstruction({
    programId: DECISION_RELAY_PROGRAM,
    keys: [
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: storagePda, isSigner: false, isWritable: false },
      { pubkey: ESCROW_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: casePda, isSigner: false, isWritable: true },
      { pubkey: params.claimant, isSigner: false, isWritable: true },
      { pubkey: params.respondent, isSigner: false, isWritable: true },
      { pubkey: escrowAuthorityPda, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// Real Ed25519 signing with a test attestor's actual secret key — not a
// mock. Builds the real Ed25519SigVerify111... native-program
// instruction the runtime verifies, same helper apps/web/src/lib/
// solana-settle.ts uses for the real backend attestor key.
function signWithAttestor(attestor: Keypair, message: Buffer): TransactionInstruction {
  return Ed25519Program.createInstructionWithPrivateKey({
    privateKey: attestor.secretKey,
    message,
  });
}

// Mirrors production's DECISION_RELAY_LOOKUP_TABLE (apps/web/src/lib/
// solana-settle.ts) — 2+ Ed25519 instructions plus AttestedSettle's own
// 7 accounts overflow Solana's 1232-byte legacy transaction limit for
// any realistic case_id, confirmed by hitting exactly this limit here.
// A v0 transaction referencing accounts via one lookup table (created
// once, extended per case with claimant/respondent/casePda) is what
// production does to fit, so the test does the same rather than
// papering over it with artificially short case_ids.
async function createLookupTable(connection: Connection, payer: Keypair): Promise<PublicKey> {
  // localnet produces slots fast enough that "the current slot" can
  // already be stale by the time this lands — back off a few slots,
  // same workaround used elsewhere against test-validator flakiness.
  const slot = await connection.getSlot("finalized");
  const [createIx, lookupTableAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: Math.max(slot - 1, 0),
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(createIx), [payer]);

  const storagePda = pda([Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("storage")], DECISION_RELAY_PROGRAM);
  const escrowAuthorityPda = pda(
    [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("escrow_authority")],
    DECISION_RELAY_PROGRAM
  );
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: lookupTableAddress,
    addresses: [SYSVAR_INSTRUCTIONS_PUBKEY, storagePda, ESCROW_PROGRAM, escrowAuthorityPda, DECISION_RELAY_PROGRAM],
  });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(extendIx), [payer]);
  await connection.confirmTransaction(sig, "finalized");
  return lookupTableAddress;
}

async function extendLookupTableAndWait(connection: Connection, payer: Keypair, lookupTableAddress: PublicKey, addresses: PublicKey[]) {
  const existing = await connection.getAddressLookupTable(lookupTableAddress);
  const existingKeys = new Set(existing.value?.state.addresses.map((a) => a.toBase58()) ?? []);
  const missing = addresses.filter((a) => !existingKeys.has(a.toBase58()));
  if (missing.length === 0) return;
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: lookupTableAddress,
    addresses: missing,
  });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(extendIx), [payer], { commitment: "finalized" });
  await connection.confirmTransaction(sig, "finalized");
}

async function sendVersioned(
  connection: Connection,
  payer: Keypair,
  lookupTableAddress: PublicKey,
  instructions: TransactionInstruction[]
) {
  const lookupTable = await connection.getAddressLookupTable(lookupTableAddress);
  const lookupTableAccounts: AddressLookupTableAccount[] = lookupTable.value ? [lookupTable.value] : [];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTableAccounts);
  const tx = new VersionedTransaction(messageV0);
  tx.sign([payer]);
  const signature = await connection.sendTransaction(tx);
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
  return signature;
}

async function initDecisionRelayStorage(connection: Connection, payer: Keypair) {
  const storagePda = pda([Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("storage")], DECISION_RELAY_PROGRAM);
  const existing = await connection.getAccountInfo(storagePda);
  if (existing) return;
  const dummyMailbox = Keypair.generate().publicKey; // dispatch_case_originate/handle aren't exercised by this suite — only attested_settle, which never reads storage.mailbox
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
  await sendAndConfirmTransaction(connection, new Transaction().add(ix), [payer]);
}

async function initializeCase(
  connection: Connection,
  payer: Keypair,
  caseId: string,
  claimant: Keypair,
  respondent: PublicKey,
  amountLamports: bigint
) {
  const escrowAuthorityPda = pda(
    [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("escrow_authority")],
    DECISION_RELAY_PROGRAM
  );
  const casePda = pda([Buffer.from("case"), Buffer.from(caseId, "utf-8")], ESCROW_PROGRAM);

  // Anchor discriminator for `initialize_case`: sha256("global:initialize_case")[0..8]
  const crypto = await import("crypto");
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

  // fund the claimant so it can pay both rent and the deposited amount
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: claimant.publicKey, lamports: amountLamports + 10_000_000n })),
    [payer]
  );
  await sendAndConfirmTransaction(connection, new Transaction().add(ix), [claimant]);
  return casePda;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(process.env.LOCALNET_PAYER ?? `${process.env.HOME}/.config/solana/id.json`, "utf-8")))
  );

  const attestor1 = loadFixtureKeypair("attestor1.json");
  const attestor2 = loadFixtureKeypair("attestor2.json");
  const attestor3 = loadFixtureKeypair("attestor3.json");
  const nonAttestor = Keypair.generate(); // never in ATTESTOR_PUBKEYS — used for a negative case

  console.log(`decision-relay (test-attestors build): ${DECISION_RELAY_PROGRAM.toBase58()}`);
  console.log(`escrow: ${ESCROW_PROGRAM.toBase58()}`);

  await initDecisionRelayStorage(connection, payer);
  const lookupTableAddress = await createLookupTable(connection, payer);

  let passed = 0;
  let failed = 0;
  async function check(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  PASS ${name}`);
      passed++;
    } catch (e: any) {
      console.log(`  FAIL ${name}: ${e.message ?? e}`);
      failed++;
    }
  }

  // --- 1. release (claimant gets 100%), 2-of-3 real attestor signatures ---
  await check("release: 2-of-3 real signatures settles 10000/0 to claimant", async () => {
    const caseId = `LOCAL-RELEASE-${Date.now()}`;
    const claimant = Keypair.generate();
    const respondent = Keypair.generate();
    const amount = 1_000_000_000n; // 1 SOL
    const casePda = await initializeCase(connection, payer, caseId, claimant, respondent.publicKey, amount);

    const message = decisionAttestationMessage({
      programId: DECISION_RELAY_PROGRAM,
      caseId,
      claimant: claimant.publicKey,
      respondent: respondent.publicKey,
      escrowProgram: ESCROW_PROGRAM,
      claimantShareBps: 10000,
      respondentShareBps: 0,
      decisionHash: Buffer.alloc(32, 1),
    });

    await extendLookupTableAndWait(connection, payer, lookupTableAddress, [claimant.publicKey, respondent.publicKey, casePdaFor(caseId)]);
    const instructions = [
      signWithAttestor(attestor1, message),
      signWithAttestor(attestor2, message),
      buildAttestedSettleIx({
        caseId,
        claimant: claimant.publicKey,
        respondent: respondent.publicKey,
        claimantShareBps: 10000,
        respondentShareBps: 0,
        decisionHash: Buffer.alloc(32, 1),
      })
    ];
    await sendVersioned(connection, payer, lookupTableAddress, instructions);

    // claimant started with amount + 10_000_000 lamports (initializeCase's
    // funding), deposited `amount` into the case PDA, then got the full
    // `amount` back from settle — net balance is ~10_000_000 (the
    // untouched top-up) + amount, minus tx fees.
    const claimantBalance = await connection.getBalance(claimant.publicKey);
    assert.ok(claimantBalance > 1_000_000_000, `claimant should have received the full deposit back, got ${claimantBalance}`);
    const caseInfo = await connection.getAccountInfo(casePda);
    assert.ok(caseInfo, "case account should still exist (escrow.settle doesn't close it)");
  });

  // --- 2. refund (respondent gets 100%) ---
  await check("refund: 2-of-3 real signatures settles 0/10000 to respondent", async () => {
    const caseId = `LOCAL-REFUND-${Date.now()}`;
    const claimant = Keypair.generate();
    const respondent = Keypair.generate();
    const amount = 500_000_000n;
    await initializeCase(connection, payer, caseId, claimant, respondent.publicKey, amount);

    const message = decisionAttestationMessage({
      programId: DECISION_RELAY_PROGRAM,
      caseId,
      claimant: claimant.publicKey,
      respondent: respondent.publicKey,
      escrowProgram: ESCROW_PROGRAM,
      claimantShareBps: 0,
      respondentShareBps: 10000,
      decisionHash: Buffer.alloc(32, 2),
    });

    await extendLookupTableAndWait(connection, payer, lookupTableAddress, [claimant.publicKey, respondent.publicKey, casePdaFor(caseId)]);
    const instructions = [
      signWithAttestor(attestor2, message),
      signWithAttestor(attestor3, message),
      buildAttestedSettleIx({
        caseId,
        claimant: claimant.publicKey,
        respondent: respondent.publicKey,
        claimantShareBps: 0,
        respondentShareBps: 10000,
        decisionHash: Buffer.alloc(32, 2),
      })
    ];
    await sendVersioned(connection, payer, lookupTableAddress, instructions);

    const respondentBalance = await connection.getBalance(respondent.publicKey);
    assert.ok(respondentBalance >= 500_000_000, `respondent should have received the full deposit, got ${respondentBalance}`);
  });

  // --- 3. partial (bps split) — the same settle instruction parameterized differently; there is no separate on-chain "partial" code path, see README ---
  await check("partial: 2-of-3 signatures settles an arbitrary 6000/4000 split", async () => {
    const caseId = `LOCAL-PARTIAL-${Date.now()}`;
    const claimant = Keypair.generate();
    const respondent = Keypair.generate();
    const amount = 1_000_000_000n;
    await initializeCase(connection, payer, caseId, claimant, respondent.publicKey, amount);

    const message = decisionAttestationMessage({
      programId: DECISION_RELAY_PROGRAM,
      caseId,
      claimant: claimant.publicKey,
      respondent: respondent.publicKey,
      escrowProgram: ESCROW_PROGRAM,
      claimantShareBps: 6000,
      respondentShareBps: 4000,
      decisionHash: Buffer.alloc(32, 3),
    });

    await extendLookupTableAndWait(connection, payer, lookupTableAddress, [claimant.publicKey, respondent.publicKey, casePdaFor(caseId)]);
    const instructions = [
      signWithAttestor(attestor1, message),
      signWithAttestor(attestor3, message),
      buildAttestedSettleIx({
        caseId,
        claimant: claimant.publicKey,
        respondent: respondent.publicKey,
        claimantShareBps: 6000,
        respondentShareBps: 4000,
        decisionHash: Buffer.alloc(32, 3),
      })
    ];
    await sendVersioned(connection, payer, lookupTableAddress, instructions);

    const claimantBalance = await connection.getBalance(claimant.publicKey);
    const respondentBalance = await connection.getBalance(respondent.publicKey);
    assert.ok(claimantBalance > 600_000_000 && claimantBalance < 700_000_000, `claimant should have ~0.6 SOL, got ${claimantBalance}`);
    assert.ok(respondentBalance >= 400_000_000, `respondent should have ~0.4 SOL, got ${respondentBalance}`);
  });

  // --- 4. quorum NOT met: only 1-of-3 real signatures must be rejected ---
  await check("rejects settlement with only 1-of-3 valid attestor signatures", async () => {
    const caseId = `LOCAL-QUORUM-FAIL-${Date.now()}`;
    const claimant = Keypair.generate();
    const respondent = Keypair.generate();
    const amount = 200_000_000n;
    await initializeCase(connection, payer, caseId, claimant, respondent.publicKey, amount);

    const message = decisionAttestationMessage({
      programId: DECISION_RELAY_PROGRAM,
      caseId,
      claimant: claimant.publicKey,
      respondent: respondent.publicKey,
      escrowProgram: ESCROW_PROGRAM,
      claimantShareBps: 10000,
      respondentShareBps: 0,
      decisionHash: Buffer.alloc(32, 4),
    });

    await extendLookupTableAndWait(connection, payer, lookupTableAddress, [claimant.publicKey, respondent.publicKey, casePdaFor(caseId)]);
    const instructions = [
      signWithAttestor(attestor1, message),
      buildAttestedSettleIx({
        caseId,
        claimant: claimant.publicKey,
        respondent: respondent.publicKey,
        claimantShareBps: 10000,
        respondentShareBps: 0,
        decisionHash: Buffer.alloc(32, 4),
      })
    ];
    let threw = false;
    try {
      await sendVersioned(connection, payer, lookupTableAddress, instructions);
    } catch {
      threw = true;
    }
    assert.ok(threw, "a single attestor signature must not reach 2-of-3 threshold");
  });

  // --- 5. duplicate signature from the same attestor must not count twice ---
  await check("rejects settlement where the same attestor signs twice instead of 2 distinct attestors", async () => {
    const caseId = `LOCAL-DUP-SIGNER-${Date.now()}`;
    const claimant = Keypair.generate();
    const respondent = Keypair.generate();
    const amount = 200_000_000n;
    await initializeCase(connection, payer, caseId, claimant, respondent.publicKey, amount);

    const message = decisionAttestationMessage({
      programId: DECISION_RELAY_PROGRAM,
      caseId,
      claimant: claimant.publicKey,
      respondent: respondent.publicKey,
      escrowProgram: ESCROW_PROGRAM,
      claimantShareBps: 10000,
      respondentShareBps: 0,
      decisionHash: Buffer.alloc(32, 5),
    });

    // attestor1 signs twice (occupying both scanned Ed25519 slots) —
    // count_distinct_registered_signers must collapse this to 1, not 2.
    await extendLookupTableAndWait(connection, payer, lookupTableAddress, [claimant.publicKey, respondent.publicKey, casePdaFor(caseId)]);
    const instructions = [
      signWithAttestor(attestor1, message),
      signWithAttestor(attestor1, message),
      buildAttestedSettleIx({
        caseId,
        claimant: claimant.publicKey,
        respondent: respondent.publicKey,
        claimantShareBps: 10000,
        respondentShareBps: 0,
        decisionHash: Buffer.alloc(32, 5),
      })
    ];
    let threw = false;
    try {
      await sendVersioned(connection, payer, lookupTableAddress, instructions);
    } catch {
      threw = true;
    }
    assert.ok(threw, "duplicate signature from one attestor must not satisfy the 2-of-3 threshold");
  });

  // --- 6. a signature from a non-attestor key doesn't count toward quorum ---
  await check("a real signature from a non-registered key doesn't count toward quorum", async () => {
    const caseId = `LOCAL-NON-ATTESTOR-${Date.now()}`;
    const claimant = Keypair.generate();
    const respondent = Keypair.generate();
    const amount = 200_000_000n;
    await initializeCase(connection, payer, caseId, claimant, respondent.publicKey, amount);

    const message = decisionAttestationMessage({
      programId: DECISION_RELAY_PROGRAM,
      caseId,
      claimant: claimant.publicKey,
      respondent: respondent.publicKey,
      escrowProgram: ESCROW_PROGRAM,
      claimantShareBps: 10000,
      respondentShareBps: 0,
      decisionHash: Buffer.alloc(32, 6),
    });

    await extendLookupTableAndWait(connection, payer, lookupTableAddress, [claimant.publicKey, respondent.publicKey, casePdaFor(caseId)]);
    const instructions = [
      signWithAttestor(attestor1, message),
      signWithAttestor(nonAttestor, message), // real, valid Ed25519 signature, but nonAttestor is not in ATTESTOR_PUBKEYS
      buildAttestedSettleIx({
        caseId,
        claimant: claimant.publicKey,
        respondent: respondent.publicKey,
        claimantShareBps: 10000,
        respondentShareBps: 0,
        decisionHash: Buffer.alloc(32, 6),
      })
    ];
    let threw = false;
    try {
      await sendVersioned(connection, payer, lookupTableAddress, instructions);
    } catch {
      threw = true;
    }
    assert.ok(threw, "1 real registered attestor + 1 real non-attestor signature must still fail the 2-of-3 threshold");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
