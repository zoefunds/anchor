import { createHash } from "crypto";
import { Connection, PublicKey } from "@solana/web3.js";

// Real, on-chain-authoritative deposit tracking for the Sealevel
// (Solana) reference escrow program (chains/solana/programs/escrow),
// mirroring the rigor lib/case-settlement.ts and lib/escrow.ts already
// apply on the EVM side. Built 2026-09-06 in direct response to a real
// gap: dispatchDecisionForCase's Solana branch (lib/hyperlane.ts) calls
// submitAttestedSettle straight off the Case row's own settlementSolana*
// fields with no deposit-confirmation gate at all — unlike the EVM
// branch, which re-reads live on-chain deposit state before every
// dispatch. This module is what closes that gap: real PDA reads, never
// a caller-supplied claim.
//
// Solana has no ABI-shape-probing equivalent (escrow-version.ts's whole
// reason to exist on the EVM side) — this is a single, fixed Anchor
// account layout, so verification here means "does the account exist
// and hold what CaseSettlement claims," not "which of several known
// shapes does it match."

export class SolanaEscrowError extends Error {}

/**
 * Decimal SOL amount -> lamports (9 decimals) — the Solana-native
 * equivalent of lib/genlayer.ts's toAttoAmount (18 decimals, EVM-native).
 * A separate function, not a parametrized one, because CaseSettlement's
 * `expectedAmountAtto` field name is genuinely EVM-shaped (atto = 1e-18)
 * and reusing that name/precision for a 9-decimal chain would be its
 * own source of silent bugs; call sites must know which chain they're
 * on and choose the matching converter deliberately.
 */
export function toLamports(amount: number | string): bigint {
  const str = typeof amount === "number" ? amount.toString() : amount;
  if (!/^\d+(\.\d+)?$/.test(str)) {
    throw new SolanaEscrowError(`toLamports: not a valid non-negative decimal string: ${str}`);
  }
  const [whole, frac = ""] = str.split(".");
  if (frac.length > 9) {
    throw new SolanaEscrowError(`toLamports: amount has more than 9 fractional digits, would lose precision: ${str}`);
  }
  const fracPadded = frac.padEnd(9, "0");
  return BigInt(whole) * 10n ** 9n + BigInt(fracPadded || "0");
}

function getConnection(): Connection {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new SolanaEscrowError("SOLANA_RPC_URL is not set — see apps/web/.env.example");
  }
  return new Connection(rpcUrl, "confirmed");
}

/** Base58, decodes to exactly 32 bytes — the only shape a real Solana pubkey has. Never assumes valid just because base58-decodable (e.g. a 20-byte EVM-style value can also happen to be valid base58). */
export function normalizeSolanaAddress(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const pk = new PublicKey(raw);
    return pk.toBase58();
  } catch {
    return null;
  }
}

// decision-relay's own PDA seeds — see
// chains/solana/programs/decision-relay/src/lib.rs's
// decision_relay_storage_pda_seeds! macro. Duplicated here deliberately
// (not imported, there's no shared TS/Rust seed source) — if that
// macro's literal seeds ever change, this must be updated in the same
// commit, the same discipline applied to every other cross-language
// address-derivation constant in this project.
const STORAGE_SEED_PARTS = [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("storage")];
const CASE_SEED_PREFIX = Buffer.from("case");

function deriveDecisionRelayStoragePda(decisionRelayProgramId: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(STORAGE_SEED_PARTS, new PublicKey(decisionRelayProgramId));
  return pda;
}

function deriveEscrowCasePda(escrowProgramId: string, onChainCaseId: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([CASE_SEED_PREFIX, Buffer.from(onChainCaseId, "utf8")], new PublicKey(escrowProgramId));
  return pda;
}

/**
 * decision-relay's DecisionRelayStorage account is a raw
 * AccountData<T> wrapper (this program predates/doesn't use the Anchor
 * framework — see its own lib.rs header) with a 1-byte presence tag
 * followed by the Borsh-serialized struct { mailbox: Pubkey,
 * escrow_program: Pubkey } — see
 * chains/hyperlane-validator/deployment.json's own documented layout
 * note for ReplayGuard, the same wrapper convention. NOT an Anchor
 * 8-byte-discriminator account.
 */
function parseDecisionRelayStorage(data: Buffer): { initialized: boolean; mailbox: string; escrowProgram: string } {
  if (data.length < 1 + 32 + 32) {
    throw new SolanaEscrowError(`decision-relay storage account data too short (${data.length} bytes) — expected at least 65`);
  }
  const initialized = data[0] === 1;
  const mailbox = new PublicKey(data.subarray(1, 33)).toBase58();
  const escrowProgram = new PublicKey(data.subarray(33, 65)).toBase58();
  return { initialized, mailbox, escrowProgram };
}

/**
 * Registration-time check, mirroring
 * case-settlement.ts's assertEscrowBoundToDecisionRelay for EVM: reads
 * decision-relay's own on-chain storage and requires its escrow_program
 * to equal the escrow being registered — an org pasting in ANY Solana
 * program address as an "escrow" without this check would only
 * discover the mismatch at settlement time, when attested_settle's own
 * escrow_program equality check (lib.rs) rejects the CPI.
 */
export async function assertSolanaEscrowBoundToDecisionRelay(params: { escrowProgramId: string; decisionRelayProgramId: string }): Promise<void> {
  const connection = getConnection();
  const storagePda = deriveDecisionRelayStoragePda(params.decisionRelayProgramId);
  const accountInfo = await connection.getAccountInfo(storagePda);
  if (!accountInfo) {
    throw new SolanaEscrowError(
      `decision-relay program ${params.decisionRelayProgramId}'s storage PDA (${storagePda.toBase58()}) does not exist on-chain — is this really a deployed, initialized decision-relay program?`
    );
  }
  const storage = parseDecisionRelayStorage(accountInfo.data);
  if (!storage.initialized) {
    throw new SolanaEscrowError(`decision-relay storage PDA exists but is not initialized (presence tag unset)`);
  }
  if (storage.escrowProgram !== params.escrowProgramId) {
    throw new SolanaEscrowError(
      `decision-relay ${params.decisionRelayProgramId}'s configured escrow_program is ${storage.escrowProgram}, not the escrow ${params.escrowProgramId} being registered — refusing to bind an integration attested_settle can never actually reach (its own escrow_program equality check would reject this CPI)`
    );
  }
}

const CASE_STATUS = ["Active", "Disputed", "Settled"] as const;
type CaseStatus = (typeof CASE_STATUS)[number];

interface ParsedEscrowCase {
  caseId: string;
  claimant: string;
  respondent: string;
  adjudicator: string;
  amountLamports: bigint;
  status: CaseStatus;
}

// Anchor account discriminator: first 8 bytes of sha256("account:Case")
// — see Anchor's own #[account] macro. Computed here rather than
// hardcoded so the derivation itself stays legible and auditable.
function caseAccountDiscriminator(): Buffer {
  return createHash("sha256").update("account:Case").digest().subarray(0, 8);
}

/**
 * Deserializes chains/solana/programs/escrow's `Case` account
 * (#[account] pub struct Case { case_id: String, claimant: Pubkey,
 * respondent: Pubkey, adjudicator: Pubkey, amount_lamports: u64,
 * status: CaseStatus, bump: u8 }) directly from raw account bytes —
 * Borsh layout: 8-byte Anchor discriminator, then case_id as a 4-byte
 * LE length prefix + UTF-8 bytes, then 3 pubkeys (32 bytes each), then
 * amount_lamports as u64 LE, then a 1-byte enum tag, then a 1-byte bump.
 * Never uses an SDK-generated decoder (none exists for this reference
 * program) — this is a manual, from-source parser, so it must be kept
 * in lockstep with chains/solana/programs/escrow/src/lib.rs's actual
 * struct definition if that ever changes.
 */
export function parseEscrowCaseAccount(data: Buffer): ParsedEscrowCase {
  const expectedDiscriminator = caseAccountDiscriminator();
  if (data.length < 8 || !data.subarray(0, 8).equals(expectedDiscriminator)) {
    throw new SolanaEscrowError("account data does not start with the expected Case discriminator — not a Case account, or the program's account layout has changed");
  }
  let offset = 8;
  if (data.length < offset + 4) throw new SolanaEscrowError("Case account truncated reading case_id length");
  const caseIdLen = data.readUInt32LE(offset);
  offset += 4;
  if (data.length < offset + caseIdLen) throw new SolanaEscrowError("Case account truncated reading case_id bytes");
  const caseId = data.subarray(offset, offset + caseIdLen).toString("utf8");
  offset += caseIdLen;

  if (data.length < offset + 32 * 3 + 8 + 1 + 1) throw new SolanaEscrowError("Case account truncated reading fixed-size fields");
  const claimant = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const respondent = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const adjudicator = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
  offset += 32;
  const amountLamports = data.readBigUInt64LE(offset);
  offset += 8;
  const statusTag = data.readUInt8(offset);
  offset += 1;
  const status = CASE_STATUS[statusTag];
  if (!status) throw new SolanaEscrowError(`Case account has unrecognized status tag ${statusTag}`);

  return { caseId, claimant, respondent, adjudicator, amountLamports, status };
}

/**
 * Dispatch-time re-verification, mirroring lib/escrow.ts's
 * assertEscrowDepositMatches for EVM: called immediately before
 * submitAttestedSettle, never trusting that a DEPOSITED CaseSettlement
 * row still reflects live chain state (the realistic drift here is
 * smaller than EVM's redeploy risk, since Solana account data can't be
 * silently swapped the way a proxy can, but re-reading at the moment
 * of use rather than trusting a cached DB status is the same fail-safe
 * discipline applied everywhere else in this codebase).
 */
export async function assertSolanaEscrowDepositMatches(params: {
  escrowProgramId: string;
  onChainCaseId: string;
  expectedClaimant: string;
  expectedRespondent: string;
  expectedAmountLamports: bigint;
}): Promise<void> {
  const connection = getConnection();
  const casePda = deriveEscrowCasePda(params.escrowProgramId, params.onChainCaseId);
  const accountInfo = await connection.getAccountInfo(casePda);
  if (!accountInfo) {
    throw new SolanaEscrowError(`no Case account found at ${casePda.toBase58()} for on-chain case id "${params.onChainCaseId}" — no deposit has been made`);
  }
  const parsed = parseEscrowCaseAccount(accountInfo.data);
  if (parsed.status === "Settled") {
    throw new SolanaEscrowError(`Case "${params.onChainCaseId}" is already Settled on-chain — refusing to dispatch a second settlement`);
  }
  if (parsed.claimant !== params.expectedClaimant || parsed.respondent !== params.expectedRespondent) {
    throw new SolanaEscrowError(
      `Case "${params.onChainCaseId}"'s on-chain claimant/respondent (${parsed.claimant}/${parsed.respondent}) does not match what this settlement expects (${params.expectedClaimant}/${params.expectedRespondent})`
    );
  }
  if (parsed.amountLamports !== params.expectedAmountLamports) {
    throw new SolanaEscrowError(
      `Case "${params.onChainCaseId}"'s on-chain amount_lamports (${parsed.amountLamports}) does not match this settlement's expected amount (${params.expectedAmountLamports})`
    );
  }
}

/**
 * Real, on-chain-authoritative deposit confirmation for a Solana
 * CaseSettlement — the Sealevel equivalent of
 * case-settlement.ts's checkAndConfirmDeposit. Never trusts anything
 * but the Case PDA's own live state: reads it directly and only
 * reports "confirmed" when live claimant/respondent/amount exactly
 * match what both parties themselves set via the settlement-address
 * route.
 */
export async function checkAndConfirmSolanaDeposit(params: {
  escrowProgramId: string;
  onChainCaseId: string;
  expectedClaimant: string;
  expectedRespondent: string;
  expectedAmountLamports: bigint;
}): Promise<{ outcome: "confirmed"; depositedAmountLamports: bigint } | { outcome: "no_deposit_yet" } | { outcome: "mismatch"; reason: string }> {
  const connection = getConnection();
  const casePda = deriveEscrowCasePda(params.escrowProgramId, params.onChainCaseId);
  const accountInfo = await connection.getAccountInfo(casePda);
  if (!accountInfo) {
    return { outcome: "no_deposit_yet" };
  }
  const parsed = parseEscrowCaseAccount(accountInfo.data);
  if (parsed.claimant !== params.expectedClaimant) {
    return { outcome: "mismatch", reason: `on-chain claimant ${parsed.claimant} does not match expected ${params.expectedClaimant}` };
  }
  if (parsed.respondent !== params.expectedRespondent) {
    return { outcome: "mismatch", reason: `on-chain respondent ${parsed.respondent} does not match expected ${params.expectedRespondent}` };
  }
  if (parsed.amountLamports !== params.expectedAmountLamports) {
    return { outcome: "mismatch", reason: `on-chain amount_lamports ${parsed.amountLamports} does not match expected ${params.expectedAmountLamports}` };
  }
  return { outcome: "confirmed", depositedAmountLamports: parsed.amountLamports };
}
