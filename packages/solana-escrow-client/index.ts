// Typed Anchor client for chains/solana/programs/escrow, generated from
// its real IDL (see README.md for exact regeneration commands) — the
// replacement for the hand-encoded sighash+Borsh instruction building
// that apps/web/scripts/e2e-solana-live.ts used to do itself because no
// such client existed. Every instruction builder here goes through
// anchor's own `program.methods.*` typed builders, so a changed
// instruction signature in escrow's Rust source is a TypeScript compile
// error here, not a silent on-chain rejection.

import { AnchorProvider, BN, Program, type Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import escrowIdl from "./idl/escrow.json" with { type: "json" };
import type { Escrow } from "./idl/escrow";

export type { Escrow };
export const ESCROW_IDL = escrowIdl as unknown as Escrow;

const CASE_SEED_PREFIX = Buffer.from("case");
const CONFIG_SEED_PREFIX = Buffer.from("config");

/** Minimal anchor.Wallet implementation over a raw Keypair — sufficient for building/simulating/signing instructions from a script or server process; never suitable for a real user's wallet (see deposit-execution.ts's own doc comment on that boundary). */
export function keypairWallet(keypair: Keypair): Wallet {
  return {
    publicKey: keypair.publicKey,
    payer: keypair,
    signTransaction: async (tx) => {
      if ("partialSign" in tx) tx.partialSign(keypair);
      else tx.sign([keypair]);
      return tx;
    },
    signAllTransactions: async (txs) => {
      for (const tx of txs) {
        if ("partialSign" in tx) tx.partialSign(keypair);
        else tx.sign([keypair]);
      }
      return txs;
    },
  } as Wallet;
}

/**
 * Builds a typed `Program<Escrow>` bound to the given connection/wallet
 * and program id. The program id is always caller-supplied (never
 * defaulted to the IDL's own embedded `address`) because which cluster
 * a caller means to talk to — devnet vs. localnet vs. a future
 * redeploy — is deployment config, not something this generated
 * artifact should silently decide; see README.md's "Test-only vs. real"
 * section.
 */
export function getEscrowProgram(connection: Connection, wallet: Wallet, programId: string): Program<Escrow> {
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idlWithAddress: Escrow = { ...ESCROW_IDL, address: programId } as Escrow;
  return new Program<Escrow>(idlWithAddress, provider);
}

export function deriveCasePda(programId: PublicKey, onChainCaseId: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([CASE_SEED_PREFIX, Buffer.from(onChainCaseId, "utf8")], programId);
  return pda;
}

/** The program-wide emergency-refund-timeout config singleton — one per deployed escrow program, not per case. */
export function deriveConfigPda(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([CONFIG_SEED_PREFIX], programId);
  return pda;
}

/**
 * One-time setup, required before any `emergency_refund` can succeed
 * (escrow's own `initialize_config` doc comment). `authority` becomes
 * the only signer `update_emergency_refund_timeout` will ever accept —
 * deliberately a separate key from the deploy authority is fine, but it
 * must be kept, not lost, since there is no recovery path for a lost
 * config authority short of a fresh escrow deployment.
 */
export async function buildInitializeConfigInstruction(params: {
  program: Program<Escrow>;
  authority: PublicKey;
}): Promise<{ instruction: TransactionInstruction; configPda: PublicKey }> {
  const configPda = deriveConfigPda(params.program.programId);
  const instruction = await params.program.methods
    .initializeConfig()
    .accounts({ authority: params.authority })
    .instruction();
  return { instruction, configPda };
}

/** Changes the timeout for every not-yet-refunded deposit immediately (see update_emergency_refund_timeout's own doc comment for why this differs from EVM's per-contract-immutable value). */
export async function buildUpdateEmergencyRefundTimeoutInstruction(params: {
  program: Program<Escrow>;
  authority: PublicKey;
  newTimeoutSeconds: bigint;
}): Promise<TransactionInstruction> {
  return params.program.methods
    .updateEmergencyRefundTimeout(new BN(params.newTimeoutSeconds.toString()))
    .accounts({ authority: params.authority })
    .instruction();
}

/** Reads the config singleton directly — null if `initialize_config` has never been called on this program deployment. */
export async function fetchEmergencyRefundConfig(
  program: Program<Escrow>,
  configPda: PublicKey
): Promise<{ authority: PublicKey; emergencyRefundTimeoutSeconds: bigint } | null> {
  const account = await program.account.config.fetchNullable(configPda);
  if (!account) return null;
  return {
    authority: account.authority,
    emergencyRefundTimeoutSeconds: BigInt(account.emergencyRefundTimeoutSeconds.toString()),
  };
}

/** Reads a case's own deposited_at (unix seconds) directly — the same field emergency_refund's on-chain timeout check reads, so a caller can compute local eligibility before ever submitting a transaction. Null if the case account doesn't exist. */
export async function fetchCaseDepositedAt(program: Program<Escrow>, casePda: PublicKey): Promise<bigint | null> {
  const account = await program.account.case.fetchNullable(casePda);
  if (!account) return null;
  return BigInt(account.depositedAt.toString());
}

/** The escrow program's own source of truth for whether a case has actually settled on-chain — see chains/solana/programs/escrow/src/lib.rs's CaseStatus enum (Active/Disputed/Settled/Refunded). Returns null if the case account doesn't exist (never deposited into). */
export async function fetchCaseStatus(
  program: Program<Escrow>,
  casePda: PublicKey
): Promise<"active" | "disputed" | "settled" | "refunded" | null> {
  const account = await program.account.case.fetchNullable(casePda);
  if (!account) return null;
  const status = account.status as unknown as { active?: object; disputed?: object; settled?: object; refunded?: object };
  if ("settled" in status) return "settled";
  if ("refunded" in status) return "refunded";
  if ("disputed" in status) return "disputed";
  return "active";
}

/** Typed initialize_case instruction — replaces every hand-rolled sighash+Borsh encoder that used to live in apps/web/scripts/e2e-solana-live.ts. */
export async function buildInitializeCaseInstruction(params: {
  program: Program<Escrow>;
  claimant: PublicKey;
  onChainCaseId: string;
  respondent: PublicKey;
  adjudicator: PublicKey;
  amountLamports: bigint;
}): Promise<{ instruction: TransactionInstruction; casePda: PublicKey }> {
  const casePda = deriveCasePda(params.program.programId, params.onChainCaseId);
  const instruction = await params.program.methods
    .initializeCase(params.onChainCaseId, params.respondent, params.adjudicator, new BN(params.amountLamports.toString()))
    .accounts({
      claimant: params.claimant,
    })
    .instruction();
  return { instruction, casePda };
}
