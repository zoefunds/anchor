// Directly submits a settlement to decision-relay's `AttestedSettle`
// instruction on Solana — see that program's `attested_settle` doc
// comment (chains/solana/programs/decision-relay/src/lib.rs) for the
// full reasoning: Hyperlane's own delivery path for this program is
// notification-only now, since this program has no control over how the
// Hyperlane relayer builds its `process()` transaction and therefore
// can't add the Ed25519 signature-verification instruction attested
// settlement depends on. This module builds that transaction directly.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const DECISION_RELAY_ATTESTED_SETTLE_VARIANT = 2; // see DecisionRelayInstruction enum's Borsh discriminant order

export interface SolanaAttestedSettleParams {
  decisionRelayProgramId: string; // base58
  caseId: string;
  claimant: string; // base58
  respondent: string; // base58
  escrowProgram: string; // base58
  claimantShareBps: number;
  respondentShareBps: number;
  decisionHash: Buffer; // 32 raw bytes
}

/**
 * The exact bytes decision-relay's `decision_attestation_message` Rust
 * function recomputes and compares against — must stay byte-for-byte
 * identical (domain tag, field order, u16/u32 little-endian encoding) or
 * every real signature this produces fails verification on-chain. See
 * that Rust function's own doc comment for why no program-id binding is
 * needed beyond the tag (this key is Solana-specific already).
 */
export function decisionAttestationMessage(params: SolanaAttestedSettleParams): Buffer {
  const tag = Buffer.from("ANCHOR_SOLANA_DECISION_ATTESTATION_V1", "utf-8");
  const caseIdBytes = Buffer.from(params.caseId, "utf-8");
  const caseIdLen = Buffer.alloc(4);
  caseIdLen.writeUInt32LE(caseIdBytes.length);
  const claimantShareBps = Buffer.alloc(2);
  claimantShareBps.writeUInt16LE(params.claimantShareBps);
  const respondentShareBps = Buffer.alloc(2);
  respondentShareBps.writeUInt16LE(params.respondentShareBps);

  if (params.decisionHash.length !== 32) {
    throw new Error(`decisionHash must be 32 bytes, got ${params.decisionHash.length}`);
  }

  return Buffer.concat([
    tag,
    caseIdLen,
    caseIdBytes,
    new PublicKey(params.claimant).toBuffer(),
    new PublicKey(params.respondent).toBuffer(),
    new PublicKey(params.escrowProgram).toBuffer(),
    claimantShareBps,
    respondentShareBps,
    params.decisionHash,
  ]);
}

/** Matches decision-relay's `DecisionRelayBody` Borsh layout exactly — see packages/hyperlane-relay's encodeSealevelDecisionRelayBody for the same layout used on the Hyperlane notification path. */
function encodeDecisionRelayBody(params: SolanaAttestedSettleParams): Buffer {
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
    new PublicKey(params.claimant).toBuffer(),
    new PublicKey(params.respondent).toBuffer(),
    new PublicKey(params.escrowProgram).toBuffer(),
    claimantShareBps,
    respondentShareBps,
    params.decisionHash,
  ]);
}

function getAttestorKeypair(): Keypair {
  const raw = process.env.SOLANA_ATTESTOR_PRIVATE_KEY;
  if (!raw) {
    throw new Error("SOLANA_ATTESTOR_PRIVATE_KEY is not set — see apps/web/.env.example");
  }
  // Same format as the rest of this repo's Solana keys: a JSON array of
  // the 64-byte secret key (solana-keygen's own on-disk format).
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

function getRelayPayerKeypair(): Keypair {
  const raw = process.env.SOLANA_RELAY_PRIVATE_KEY;
  if (!raw) {
    throw new Error("SOLANA_RELAY_PRIVATE_KEY is not set — see apps/web/.env.example");
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/**
 * Submits a real Solana transaction: [Ed25519 signature-verification
 * instruction, decision-relay's AttestedSettle instruction]. The Ed25519
 * instruction is what decision-relay's attested_settle reads via
 * instruction introspection (get_instruction_relative(-1, ...)) — it
 * MUST be the instruction immediately before AttestedSettle in this same
 * transaction, which is why both are added to one Transaction here
 * rather than sent separately.
 */
export async function submitAttestedSettle(
  params: SolanaAttestedSettleParams,
  rpcUrl: string
): Promise<{ signature: string }> {
  const connection = new Connection(rpcUrl, "confirmed");
  const attestor = getAttestorKeypair();
  const payer = getRelayPayerKeypair();

  const message = decisionAttestationMessage(params);
  const ed25519Ix = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: attestor.secretKey,
    message,
  });

  const programId = new PublicKey(params.decisionRelayProgramId);
  const [storagePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("storage")],
    programId
  );
  const [escrowAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("escrow_authority")],
    programId
  );
  const escrowProgramId = new PublicKey(params.escrowProgram);
  const [casePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("case"), Buffer.from(params.caseId, "utf-8")],
    escrowProgramId
  );

  const instructionData = Buffer.concat([Buffer.from([DECISION_RELAY_ATTESTED_SETTLE_VARIANT]), encodeDecisionRelayBody(params)]);

  const attestedSettleIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: storagePda, isSigner: false, isWritable: false },
      { pubkey: escrowProgramId, isSigner: false, isWritable: false },
      { pubkey: casePda, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(params.claimant), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(params.respondent), isSigner: false, isWritable: true },
      { pubkey: escrowAuthorityPda, isSigner: false, isWritable: false },
    ],
    data: instructionData,
  });

  const tx = new Transaction().add(ed25519Ix).add(attestedSettleIx);
  const signature = await sendAndConfirmTransaction(connection, tx, [payer]);
  return { signature };
}
