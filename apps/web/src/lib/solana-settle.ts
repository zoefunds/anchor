// Directly submits a settlement to decision-relay's `AttestedSettle`
// instruction on Solana — see that program's `attested_settle` doc
// comment (chains/solana/programs/decision-relay/src/lib.rs) for the
// full reasoning: Hyperlane's own delivery path for this program is
// notification-only now, since this program has no control over how the
// Hyperlane relayer builds its `process()` transaction and therefore
// can't add the Ed25519 signature-verification instruction attested
// settlement depends on. This module builds that transaction directly.

import { createPublicKey, verify as cryptoVerify } from "crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  AddressLookupTableAccount,
  AddressLookupTableProgram,
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

// Solana Testnet's real genesis hash — confirmed live via the
// `getGenesisHash` RPC method, not guessed. Must match the
// TESTNET_GENESIS_HASH constant in decision-relay's Rust
// decision_attestation_message exactly.
const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";

/**
 * The exact bytes decision-relay's `decision_attestation_message` Rust
 * function recomputes and compares against — must stay byte-for-byte
 * identical (domain tag, cluster/program binding, field order, u16/u32
 * little-endian encoding) or every real signature this produces fails
 * verification on-chain. Cluster (genesis hash) and program_id binding
 * added after a re-audit asked for it as defense in depth — see that
 * Rust function's own doc comment for what each does and doesn't
 * guarantee.
 */
export function decisionAttestationMessage(params: SolanaAttestedSettleParams): Buffer {
  const tag = Buffer.from("ANCHOR_SOLANA_DECISION_ATTESTATION_V2", "utf-8");
  const genesisHash = new PublicKey(TESTNET_GENESIS_HASH).toBuffer();
  const programId = new PublicKey(params.decisionRelayProgramId).toBuffer();
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
    genesisHash,
    programId,
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

/**
 * M-of-N (2-of-2, matching the deployed ATTESTOR_PUBKEYS/ATTESTOR_THRESHOLD
 * consts in decision-relay's Rust source): the backend holds exactly ONE
 * of the two attestor keys — the second is generated and held entirely
 * offline (see docs/multisig-attestor-setup.md's Solana section), so
 * this deliberately has no plural "keys" equivalent to EVM's
 * ATTESTOR_PRIVATE_KEYS. A real settlement needs BOTH this key's
 * signature AND one supplied externally via `externalAttestation` below.
 */
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

/** A signature collected from the externally/offline-held attestor key (see docs/multisig-attestor-setup.md) — never the private key itself, only the resulting 64-byte Ed25519 signature over the exact bytes decisionAttestationMessage() produces for this decision. */
export interface ExternalSolanaAttestation {
  /** The offline attestor's public key (must be one of decision-relay's ATTESTOR_PUBKEYS on-chain). */
  publicKey: Uint8Array;
  /** 64-byte Ed25519 signature over decisionAttestationMessage(params). */
  signature: Uint8Array;
}

/**
 * JSON-serializable form of ExternalSolanaAttestation, for persisting
 * in Decision.pendingSolanaAttestations (a Prisma Json column — raw
 * Uint8Array/Buffer values don't round-trip through JSON). base64
 * chosen over base58/hex purely for compactness; either would work.
 */
export interface SolanaAttestationRecord {
  publicKey: string; // base64
  signature: string; // base64
}

/**
 * Must match decision-relay's Rust ATTESTOR_PUBKEYS constant exactly —
 * see chains/solana/programs/decision-relay/src/lib.rs. The client-side
 * copy exists so this function can reject a malformed/unknown/duplicate
 * external attestation BEFORE spending a real transaction fee on a
 * guaranteed on-chain revert, mirroring the EVM side's isRegisteredAttestor
 * check in lib/hyperlane.ts. Update this array (and ATTESTOR_THRESHOLD
 * below) if the Rust consts are ever rotated — there is deliberately no
 * on-chain read path for this the way EVM's attestorThreshold()/isAttestor()
 * views work, since decision-relay has no equivalent governance account
 * (see docs/multisig-attestor-setup.md's Solana section).
 */
// 2026-09-07: retired the pure-offline key, added two automated
// signers (anc-hor-attestor2/3, same Fly apps already automating the
// EVM side) — must exactly mirror decision-relay's Rust ATTESTOR_PUBKEYS
// const after its matching upgrade deploy.
const ATTESTOR_PUBKEYS = [
  "4EnM9nxVcWoaRRsEZnq2otdVrQLiwdBsBkqxdmRoVBCq",
  "4eCqu5xB2EoLFw5AfSyjTm3cRnjdocs6wfwGaSp7rigZ",
  "9uKHpvMk9tijzwXFicojZ5z4RnNdcLfqaDxDfjNGGMn1",
];
const ATTESTOR_THRESHOLD = 2; // must match decision-relay's Rust ATTESTOR_THRESHOLD const exactly

/** Exposed so callers (e.g. lib/hyperlane.ts, the pending-solana-attestations API routes) can validate a submitted external attestation's public key without duplicating this list. */
export function isRegisteredSolanaAttestor(publicKeyBase58: string): boolean {
  return ATTESTOR_PUBKEYS.includes(publicKeyBase58);
}

// Fixed 12-byte SPKI DER prefix for a raw 32-byte Ed25519 public key —
// same well-known constant used elsewhere in this project's offline
// signing tooling this session (Node has no raw-key Ed25519 verify API,
// only DER-wrapped, so this is required, not decorative).
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Verifies a real Ed25519 signature (Node's built-in crypto — no
 * external dependency) over `messageHex` from `publicKeyBase58` —
 * used by the pending-solana-attestations sign route to reject an
 * invalid/forged signature BEFORE it's ever stored, mirroring the EVM
 * side's recoverAddress-then-isRegisteredAttestor check in
 * lib/hyperlane.ts (Solana's Ed25519 isn't recoverable, so this takes
 * the claimed public key directly and verifies against it, rather than
 * recovering one).
 */
export function verifySolanaAttestationSignature(publicKeyBase58: string, messageHex: string, signatureHex: string): boolean {
  try {
    const publicKeyBytes = new PublicKey(publicKeyBase58).toBytes();
    const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]), format: "der", type: "spki" });
    const message = Buffer.from(messageHex.startsWith("0x") ? messageHex.slice(2) : messageHex, "hex");
    const signature = Buffer.from(signatureHex.startsWith("0x") ? signatureHex.slice(2) : signatureHex, "hex");
    if (signature.length !== 64) return false;
    return cryptoVerify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

export function getSolanaAttestorThreshold(): number {
  return ATTESTOR_THRESHOLD;
}

/**
 * Thrown when the backend's own SOLANA_ATTESTOR_PRIVATE_KEY, combined
 * with whatever validated externalAttestations were supplied, still
 * don't reach ATTESTOR_THRESHOLD — the Solana-side equivalent of
 * hyperlane.ts's InsufficientAttestorSignaturesError. Expected and NOT
 * a bug once real key custody is split (see
 * docs/multisig-attestor-setup.md): it means dispatch is genuinely
 * waiting on the offline attestor's signature. Carries the exact
 * message bytes (hex-encoded) the caller should persist
 * (Decision.pendingSolanaAttestationMessage) so a signature submitted
 * later via POST /api/internal/pending-solana-attestations/[decisionId]/sign
 * can complete the same dispatch without recomputing anything.
 */
export class InsufficientSolanaAttestationsError extends Error {
  constructor(
    public readonly messageHex: string,
    public readonly collectedCount: number,
    public readonly threshold: number
  ) {
    super(`only ${collectedCount} of ${threshold} required Solana attestor signatures available`);
    this.name = "InsufficientSolanaAttestationsError";
  }
}

/**
 * Validates and de-duplicates externally-supplied attestations before
 * they're ever turned into instructions — a re-audit correctly flagged
 * that the Rust program only scans the ATTESTOR_PUBKEYS.len() instructions
 * immediately preceding AttestedSettle, so a caller-supplied array with
 * extra, unknown, malformed, or duplicate-signer entries could push a
 * genuinely valid pair of signatures out of that scanned window, or
 * waste a real transaction on entries that could never have counted.
 * Returns only the entries worth turning into Ed25519 instructions,
 * each from a distinct, known, well-formed attestor pubkey that isn't
 * the backend's own key (a caller submitting the backend's own key as
 * an "external" attestation would otherwise silently NOT add a second
 * real signer).
 */
function validateExternalAttestations(
  externalAttestations: ExternalSolanaAttestation[],
  backendPublicKey: Uint8Array
): ExternalSolanaAttestation[] {
  const backendB58 = new PublicKey(backendPublicKey).toBase58();
  const seen = new Set<string>([backendB58]);
  const valid: ExternalSolanaAttestation[] = [];

  for (const ext of externalAttestations) {
    if (ext.publicKey.length !== 32 || ext.signature.length !== 64) {
      continue; // malformed — never counts, never reaches the transaction
    }
    let b58: string;
    try {
      b58 = new PublicKey(ext.publicKey).toBase58();
    } catch {
      continue;
    }
    if (!ATTESTOR_PUBKEYS.includes(b58)) continue; // not a registered attestor
    if (seen.has(b58)) continue; // duplicate signer (or the backend's own key resubmitted) — one signer counts once
    seen.add(b58);
    valid.push(ext);
    // 2026-09-07: real bug found via a live 2-of-3 dispatch — this cap
    // used to be ATTESTOR_PUBKEYS.length - 1 (total registered attestors
    // minus the backend's own slot), which grows every time an attestor
    // is added even though the required THRESHOLD hasn't changed. With
    // 3 registered attestors and both externals collected, that let 2
    // extra Ed25519 instructions into a transaction sized for 1,
    // overflowing a fixed-size buffer during serialization ("encoding
    // overruns Uint8Array"). Only ever need enough externals to reach
    // ATTESTOR_THRESHOLD, never "all attestors that happen to exist."
    if (valid.length >= ATTESTOR_THRESHOLD - 1) break;
  }

  return valid;
}

/**
 * A one-time-created Address Lookup Table (created via
 * AddressLookupTableProgram, funded by the relay payer — see
 * docs/multisig-attestor-setup.md's Solana section) holding the
 * accounts every AttestedSettle transaction references regardless of
 * case: the instructions sysvar, the Ed25519 native program, this
 * decision-relay program's own id, the escrow program, and its two PDAs.
 * Required because M-of-N (2+ Ed25519 verify instructions, each
 * embedding the full attestation message inline — Solana's Ed25519
 * native program has no way to avoid that duplication) pushes a legacy
 * transaction over Solana's 1232-byte limit for any realistic case_id;
 * confirmed by hitting exactly this limit while verifying the 2-of-2
 * upgrade live. Referencing these via a lookup table instead of raw
 * 32-byte keys in the message body is what makes the transaction fit
 * again. Optional — if unset, falls back to a legacy transaction (fine
 * for a single-signature/1-of-1 deployment, or a short enough case_id).
 */
const DECISION_RELAY_LOOKUP_TABLE = process.env.SOLANA_DECISION_RELAY_LOOKUP_TABLE;

/**
 * A settlement's claimant/respondent are dynamic per case — they can't
 * be pre-populated into DECISION_RELAY_LOOKUP_TABLE at setup time the
 * way the static accounts (program ids, PDAs) were. Left unaddressed,
 * transactions for real (never-before-seen) parties would still exceed
 * the 1232-byte limit once 2+ Ed25519 instructions are present (a real
 * gap found while live-verifying the 2-of-2 upgrade — the static-only
 * ALT alone was NOT sufficient for a realistic transaction). This
 * extends the same lookup table with any of `addresses` it doesn't
 * already contain, so a party who has settled before (or whose address
 * was proactively added) never needs another extension. A freshly
 * extended entry needs roughly one confirmed slot before it's usable in
 * another transaction — this function waits for that before returning,
 * which adds real latency (roughly one Solana slot, ~400ms-1s) the
 * first time any given claimant/respondent address is seen, but never
 * again for that same address.
 */
async function ensureLookupTableHasAddresses(
  connection: Connection,
  payer: Keypair,
  lookupTableAddress: PublicKey,
  addresses: PublicKey[]
): Promise<void> {
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
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [extendIx],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await connection.sendTransaction(tx);
  // "finalized" (not "confirmed") — a newly-extended ALT entry is only
  // usable by another transaction once the extending transaction's slot
  // is far enough in the past; confirmed alone isn't reliably sufficient
  // in practice and this only costs extra latency on an address's FIRST
  // use, never on repeat settlements for the same party.
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "finalized");
}

/**
 * Submits a real Solana transaction: [Ed25519 verify instruction(s),
 * decision-relay's AttestedSettle instruction] — one Ed25519 instruction
 * per attestor signature (M-of-N; decision-relay's ATTESTOR_THRESHOLD is
 * currently 2-of-2, so this needs the backend's own signature AND
 * exactly one externalAttestation). Each Ed25519 instruction is what
 * decision-relay's attested_settle reads via instruction introspection
 * (get_instruction_relative(-1, -2, ...)) — they MUST be the
 * instructions immediately before AttestedSettle in this same
 * transaction, which is why all of them are added to one transaction
 * here rather than sent separately. Throws if fewer than
 * ATTESTOR_THRESHOLD signatures (backend + external) are supplied,
 * mirroring hyperlane.ts's InsufficientAttestorSignaturesError on the
 * EVM side — better a clear local error than a guaranteed on-chain
 * revert burning real transaction fees.
 *
 * Builds a v0 (versioned) transaction using DECISION_RELAY_LOOKUP_TABLE
 * when configured, since the legacy format doesn't reliably fit once 2+
 * Ed25519 instructions are present (see that const's own comment).
 */
export async function submitAttestedSettle(
  params: SolanaAttestedSettleParams,
  rpcUrl: string,
  externalAttestations: ExternalSolanaAttestation[] = []
): Promise<{ signature: string }> {
  const connection = new Connection(rpcUrl, "confirmed");
  const attestor = getAttestorKeypair();
  const payer = getRelayPayerKeypair();

  const message = decisionAttestationMessage(params);

  // Filter/dedupe/cap BEFORE building any instructions — see
  // validateExternalAttestations's own doc comment. This is also what
  // guarantees correct ordering: the Ed25519 instructions built below
  // are exactly [backend, ...validated externals] with nothing else
  // interleaved, so they land as exactly the ATTESTOR_PUBKEYS.len()
  // instructions immediately preceding AttestedSettle that the Rust
  // program scans — no excess/unknown/malformed entries can ever push a
  // genuinely valid signature out of that window.
  const validExternalAttestations = validateExternalAttestations(externalAttestations, attestor.publicKey.toBytes());

  const ed25519Instructions = [
    Ed25519Program.createInstructionWithPrivateKey({ privateKey: attestor.secretKey, message }),
    ...validExternalAttestations.map((ext) =>
      Ed25519Program.createInstructionWithPublicKey({
        publicKey: ext.publicKey,
        message,
        signature: ext.signature,
      })
    ),
  ];

  const totalSignatureCount = 1 + validExternalAttestations.length;
  if (totalSignatureCount < ATTESTOR_THRESHOLD) {
    throw new InsufficientSolanaAttestationsError(`0x${message.toString("hex")}`, totalSignatureCount, ATTESTOR_THRESHOLD);
  }

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

  const lookupTableAccounts: AddressLookupTableAccount[] = [];
  if (DECISION_RELAY_LOOKUP_TABLE) {
    const lookupTableAddress = new PublicKey(DECISION_RELAY_LOOKUP_TABLE);
    // Dynamic per-case accounts (claimant/respondent/casePda) aren't part
    // of the lookup table set up at deploy time — extend it with
    // whichever of these this specific decision needs, so the
    // transaction below is guaranteed to fit under the 1232-byte limit
    // regardless of how many Ed25519 instructions M-of-N requires. See
    // this function's own comment for why this only costs latency on a
    // party's FIRST settlement, never repeat ones.
    //
    // 2026-09-07: casePda was missing from this list — a real bug found
    // live (an older stuck case still overflowed to 1247 raw bytes, 15
    // over the limit, even after capping external attestations to
    // threshold-1). Unlike claimant/respondent, casePda is unique per
    // case and never reused, so adding it to a shared, permanent ALT is
    // a one-way cost (the ALT is capped at 256 entries) — acceptable at
    // today's volume, but worth revisiting (e.g. a rotating ALT) if this
    // system processes hundreds of Solana cases.
    await ensureLookupTableHasAddresses(connection, payer, lookupTableAddress, [
      new PublicKey(params.claimant),
      new PublicKey(params.respondent),
      casePda,
    ]);
    const lookupTable = await connection.getAddressLookupTable(lookupTableAddress);
    if (lookupTable.value) lookupTableAccounts.push(lookupTable.value);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [...ed25519Instructions, attestedSettleIx],
  }).compileToV0Message(lookupTableAccounts);

  const tx = new VersionedTransaction(messageV0);
  tx.sign([payer]);

  const signature = await connection.sendTransaction(tx);
  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
  return { signature };
}
