// PHASE 3.5, item 1: the app-side deposit EXECUTION helper that never
// existed before this — apps/web/src/lib/case-settlement.ts and
// solana-escrow.ts only ever VERIFY a deposit that already landed
// (checkAndConfirmDeposit / checkAndConfirmSolanaDeposit); nothing
// constructed or submitted one. apps/web/scripts/e2e-sepolia-live.ts and
// e2e-solana-live.ts each duplicated ad-hoc deposit logic to fill that
// gap — this module is the single real implementation both now call.
//
// IMPORTANT — this is script/ops/test infrastructure, not a
// user-facing code path. A real claimant deposits from their OWN wallet
// in the frontend (their browser signs, their key never leaves it); the
// backend only ever VERIFIES that deposit server-side via
// checkAndConfirmDeposit/checkAndConfirmSolanaDeposit. There is no
// production env var that represents "the backend holds a claimant's
// key" — E2E_SEPOLIA_DEPOSITOR_PRIVATE_KEY / E2E_SOLANA_DEPOSITOR_SECRET_KEY
// are test-only secrets a human running a live-testnet script supplies
// themselves. Do NOT wire executeEvmDeposit/executeSolanaDeposit into
// any case-creation API route or anything reachable from a normal user
// request — that would mean the backend custodying claimant funds keys,
// which this codebase deliberately never does.

import { Keypair, Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { prisma } from "@/lib/prisma";
import { authorizeDepositOnChain, checkAndConfirmDeposit } from "@/lib/case-settlement";
import { checkAndConfirmSolanaDeposit } from "@/lib/solana-escrow";
import { caseIdToBytes32 } from "@/lib/emergency-refund";
import { isApprovedSettlementContract, isApprovedSolanaEscrowProgram } from "@/lib/hyperlane";
import { sepoliaTxUrl, solanaTxUrl } from "@/lib/explorer-links";
import { confirmTransactionBounded } from "@/lib/solana-confirm";

export class DepositExecutionError extends Error {}

/** Normalized shape both chains' execution helpers return — the "receipt" the spec asks for, one shape regardless of which chain actually moved the funds. */
export interface DepositReceipt {
  chain: "sepolia" | "solanatestnet";
  asset: string;
  amountAtomic: string;
  escrowId: string;
  txHash: string;
  confirmationState: "confirmed";
  explorerUrl: string;
}

const DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "caseId", type: "bytes32" },
      { name: "escrowId", type: "bytes32" },
      { name: "claimant", type: "address" },
      { name: "respondent", type: "address" },
    ],
    outputs: [],
  },
] as const;

async function pollUntil<T>(label: string, timeoutMs: number, intervalMs: number, check: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new DepositExecutionError(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/**
 * Constructs, simulates, submits, and confirms a real Escrow.sol
 * deposit() call for an existing CaseSettlement — reusing
 * authorizeDepositOnChain and checkAndConfirmDeposit rather than
 * re-implementing either. Never trusts the submitted transaction's own
 * receipt status as proof the deposit landed correctly: after the
 * receipt confirms, checkAndConfirmDeposit re-reads Escrow.sol's own
 * deposits(escrowId) mapping before this returns "confirmed".
 */
export async function executeEvmDeposit(params: {
  caseSettlementId: string;
  depositorPrivateKey: string;
  timeoutMs?: number;
}): Promise<DepositReceipt> {
  const cs = await prisma.caseSettlement.findUniqueOrThrow({
    where: { id: params.caseSettlementId },
    include: { integration: true, case: true },
  });
  if (cs.integration.chain !== "sepolia") {
    throw new DepositExecutionError(`executeEvmDeposit called on a non-EVM integration (chain=${cs.integration.chain}) — use executeSolanaDeposit instead`);
  }
  if (!cs.claimantAddress || !cs.respondentAddress) {
    throw new DepositExecutionError("both parties must set their settlement address before a deposit can be executed");
  }
  if (cs.status === "DEPOSITED" || cs.status === "SETTLED") {
    throw new DepositExecutionError(`CaseSettlement ${cs.id} is already ${cs.status} — refusing to execute a second deposit`);
  }
  const settlementContract = cs.integration.escrowContractAddress as Address;

  const rpcUrl = process.env.HYPERLANE_RELAY_RPC_URL;
  if (!rpcUrl) throw new DepositExecutionError("HYPERLANE_RELAY_RPC_URL is not set — see apps/web/.env.example");
  const depositorKey = (params.depositorPrivateKey.startsWith("0x") ? params.depositorPrivateKey : `0x${params.depositorPrivateKey}`) as Hex;
  const depositorAccount = privateKeyToAccount(depositorKey);
  if (depositorAccount.address.toLowerCase() !== cs.claimantAddress.toLowerCase()) {
    throw new DepositExecutionError(
      `depositor key resolves to ${depositorAccount.address}, but this CaseSettlement's claimantAddress is ${cs.claimantAddress} — Escrow.sol's deposit() requires msg.sender === claimant`
    );
  }

  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account: depositorAccount, chain: sepolia, transport: http(rpcUrl) });

  // Real bug found and fixed 2026-09-13 (incident recovery Phase G.4):
  // this check used to run isApprovedSettlementContract against
  // `settlementContract` (the ESCROW address) — but that allowlist is
  // meant for DecisionRelay addresses (see lib/hyperlane.ts's own doc
  // comment on isApprovedSettlementContract). An escrow will never be
  // ON that list, so this either always throws (forcing every caller,
  // including this session's own E2E tests, to add the escrow to the
  // allowlist as a workaround) or, if an operator "fixes" it by adding
  // the escrow address, silently defeats the check's actual purpose:
  // proving the settlement contract this deposit is bound to is one
  // Anchor's operators actually approved. The Escrow/DecisionRelay
  // binding check and the DecisionRelay allowlist check are two
  // genuinely separate concerns and must not be conflated into one
  // address being checked against the wrong list.
  const liveDecisionRelay = (await publicClient.readContract({
    address: settlementContract,
    abi: [{ type: "function", name: "decisionRelay", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const,
    functionName: "decisionRelay",
  })) as Address;
  if (!isApprovedSettlementContract("sepolia", liveDecisionRelay)) {
    throw new DepositExecutionError(`escrow ${settlementContract}'s decisionRelay() (${liveDecisionRelay}) is not on the operator-approved list (lib/hyperlane.ts's isApprovedSettlementContract)`);
  }
  if (cs.case.settlementContract && liveDecisionRelay.toLowerCase() !== cs.case.settlementContract.toLowerCase()) {
    throw new DepositExecutionError(
      `escrow ${settlementContract}'s decisionRelay() (${liveDecisionRelay}) does not match this case's own settlementContract (${cs.case.settlementContract}) — refusing to deposit into an escrow the case's bound DecisionRelay cannot settle`
    );
  }

  const authResult = await authorizeDepositOnChain(cs.id);
  if (authResult.outcome === "not_ready") {
    throw new DepositExecutionError(`authorizeDepositOnChain not ready: ${authResult.reason}`);
  }

  const caseIdBytes32 = caseIdToBytes32(cs.caseId);
  const escrowIdBytes32 = cs.escrowId as Hex;
  const amountWei = BigInt(cs.expectedAmountAtto);
  const depositArgs = { caseId: caseIdBytes32, escrowId: escrowIdBytes32, claimant: depositorAccount.address, respondent: cs.respondentAddress as Address };

  // Simulate first — surface a revert reason before ever broadcasting.
  const { request } = await publicClient.simulateContract({
    account: depositorAccount,
    address: settlementContract,
    abi: DEPOSIT_ABI,
    functionName: "deposit",
    args: [depositArgs.caseId, depositArgs.escrowId, depositArgs.claimant, depositArgs.respondent],
    value: amountWei,
  });

  const txHash = await walletClient.writeContract(request);
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  await prisma.caseSettlement.update({ where: { id: cs.id }, data: { depositTxHash: txHash } });

  // Never trust the receipt alone — re-read the escrow's own deposits()
  // mapping via the existing, already-audited verification path.
  const confirmed = await pollUntil("deposit confirmation", params.timeoutMs ?? 120_000, 5_000, async () => {
    const result = await checkAndConfirmDeposit(cs.id);
    return result.outcome === "confirmed" ? result : result.outcome === "already_confirmed" ? { outcome: "already_confirmed" as const, txHash } : null;
  });

  return {
    chain: "sepolia",
    asset: cs.integration.assetSymbol,
    amountAtomic: cs.expectedAmountAtto,
    escrowId: escrowIdBytes32,
    txHash: "txHash" in confirmed && confirmed.txHash ? confirmed.txHash : txHash,
    confirmationState: "confirmed",
    explorerUrl: sepoliaTxUrl(txHash),
  };
}

/**
 * Constructs, simulates, submits, and confirms a real Solana escrow
 * deposit (escrow.initialize_case) for an existing CaseSettlement,
 * using the typed @anchor/solana-escrow-client rather than any
 * hand-encoded instruction bytes. Re-reads the on-chain Case PDA via
 * checkAndConfirmSolanaDeposit after confirmation, exactly like the EVM
 * path re-reads deposits(escrowId) — a confirmed transaction signature
 * alone is never treated as proof of a correct deposit.
 */
export async function executeSolanaDeposit(params: {
  caseSettlementId: string;
  depositorSecretKeyJson: string;
  timeoutMs?: number;
}): Promise<DepositReceipt> {
  const cs = await prisma.caseSettlement.findUniqueOrThrow({
    where: { id: params.caseSettlementId },
    include: { integration: true, case: true },
  });
  if (cs.integration.chain !== "solanatestnet") {
    throw new DepositExecutionError(`executeSolanaDeposit called on a non-Solana integration (chain=${cs.integration.chain}) — use executeEvmDeposit instead`);
  }
  if (!cs.claimantAddress || !cs.respondentAddress) {
    throw new DepositExecutionError("both parties must set their settlement address before a deposit can be executed");
  }
  if (cs.status === "DEPOSITED" || cs.status === "SETTLED") {
    throw new DepositExecutionError(`CaseSettlement ${cs.id} is already ${cs.status} — refusing to execute a second deposit`);
  }
  const escrowProgramId = cs.integration.escrowContractAddress;
  if (!isApprovedSolanaEscrowProgram(escrowProgramId)) {
    throw new DepositExecutionError(`escrow program ${escrowProgramId} is not on the operator-approved list (lib/hyperlane.ts's isApprovedSolanaEscrowProgram)`);
  }
  if (!cs.case.settlementSolanaCaseId || cs.case.settlementSolanaCaseId !== cs.escrowId) {
    throw new DepositExecutionError(`Case ${cs.caseId}'s settlementSolanaCaseId does not match this CaseSettlement's escrowId — refusing to derive a mismatched PDA`);
  }
  if (!cs.case.settlementContract) {
    throw new DepositExecutionError(`Case ${cs.caseId} has no settlementContract (decision-relay program id) set — required to derive the adjudicator PDA`);
  }

  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new DepositExecutionError("SOLANA_RPC_URL is not set — see apps/web/.env.example");
  const connection = new Connection(rpcUrl, "confirmed");
  // Lazy import: keeps this module loadable (e.g. by testnet-canary.ts's
  // sepolia-only path) in any deployment whose build context doesn't
  // include the packages/solana-escrow-client workspace package.
  const { getEscrowProgram, keypairWallet, buildInitializeCaseInstruction, deriveCasePda, fetchCaseStatus } = await import("@anchor/solana-escrow-client");

  const depositor = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(params.depositorSecretKeyJson)));
  if (depositor.publicKey.toBase58() !== cs.claimantAddress) {
    throw new DepositExecutionError(
      `depositor key resolves to ${depositor.publicKey.toBase58()}, but this CaseSettlement's claimantAddress is ${cs.claimantAddress} — escrow's initialize_case requires the claimant to sign their own deposit`
    );
  }

  const escrowProgramPk = new PublicKey(escrowProgramId);
  const decisionRelayProgramId = new PublicKey(cs.case.settlementContract);
  const adjudicatorPda = deriveDecisionRelayEscrowAuthority(decisionRelayProgramId);
  const respondentPubkey = new PublicKey(cs.respondentAddress);
  const amountLamports = BigInt(cs.expectedAmountAtto);

  const program = getEscrowProgram(connection, keypairWallet(depositor), escrowProgramId);

  // Real failure, observed live: `initialize_case` uses Anchor's `init`
  // (not `init_if_needed`), so the case PDA can only ever be allocated
  // once. A prior call that actually landed on-chain but whose
  // confirmation step then failed (RPC hiccup, timeout — the same class
  // of issue as the 2026-09-12 Sepolia incident) leaves
  // CaseSettlement.status never advanced past its pre-deposit state, so
  // a retry re-enters this function, rebuilds the identical
  // `initialize_case` instruction, and hits `Allocate: account ...
  // already in use` at simulation time. Checking on-chain state first —
  // rather than trusting the DB status alone — means a retry after a
  // confirmation-step failure recovers the already-landed deposit
  // instead of repeating a doomed re-init.
  const casePdaPrecheck = deriveCasePda(program.programId, cs.escrowId);
  const existingStatus = await fetchCaseStatus(program, casePdaPrecheck);
  let txSignature: string | null = null;
  if (existingStatus === null) {
    const { instruction } = await buildInitializeCaseInstruction({
      program,
      claimant: depositor.publicKey,
      onChainCaseId: cs.escrowId,
      respondent: respondentPubkey,
      adjudicator: adjudicatorPda,
      amountLamports,
    });

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const messageV0 = new TransactionMessage({
      payerKey: depositor.publicKey,
      recentBlockhash: blockhash,
      instructions: [instruction],
    }).compileToV0Message();
    const tx = new VersionedTransaction(messageV0);
    tx.sign([depositor]);

    // Simulate first — surface a program error before ever broadcasting.
    const simResult = await connection.simulateTransaction(tx, { sigVerify: false });
    if (simResult.value.err) {
      throw new DepositExecutionError(`initialize_case simulation failed: ${JSON.stringify(simResult.value.err)} — logs: ${(simResult.value.logs ?? []).join("\n")}`);
    }

    txSignature = await connection.sendTransaction(tx, { skipPreflight: false });
    // Real incident, 2026-09-12: connection.confirmTransaction's websocket
    // subscription hung indefinitely (40+ minutes, no error, no progress)
    // against the public api.testnet.solana.com RPC — a known class of bug
    // where a free/public RPC never pushes the subscription notification.
    // Uses the same shared bounded-polling helper as solana-settle.ts —
    // see lib/solana-confirm.ts's own header for why this must never be a
    // second, independently-drifting copy of this logic.
    await confirmTransactionBounded({ connection, signature: txSignature, lastValidBlockHeight }).catch((err) => {
      throw err instanceof Error ? new DepositExecutionError(err.message) : err;
    });
    await prisma.caseSettlement.update({ where: { id: cs.id }, data: { depositTxHash: txSignature } });
  }

  // Never trust the confirmed signature alone — re-read the escrow's
  // own Case PDA via the existing, already-audited verification path.
  const confirmed = await pollUntil("deposit confirmation", params.timeoutMs ?? 120_000, 5_000, async () => {
    const result = await checkAndConfirmSolanaDeposit({
      escrowProgramId,
      onChainCaseId: cs.escrowId,
      expectedClaimant: depositor.publicKey.toBase58(),
      expectedRespondent: respondentPubkey.toBase58(),
      expectedAmountLamports: amountLamports,
    });
    if (result.outcome === "confirmed") return result;
    if (result.outcome === "mismatch") throw new DepositExecutionError(`deposit landed but does not match expectations: ${result.reason}`);
    return null;
  });
  await prisma.caseSettlement.update({ where: { id: cs.id }, data: { status: "DEPOSITED", depositConfirmedAt: new Date() } });

  // txSignature is null when the on-chain precheck above found the case
  // already initialized from a prior attempt whose own signature was
  // never persisted (it failed after broadcast, before the DB write) —
  // cs.depositTxHash is the only remaining record of it, if any.
  const finalTxSignature = txSignature ?? cs.depositTxHash ?? "";

  return {
    chain: "solanatestnet",
    asset: cs.integration.assetSymbol,
    amountAtomic: confirmed.depositedAmountLamports.toString(),
    escrowId: cs.escrowId,
    txHash: finalTxSignature,
    confirmationState: "confirmed",
    explorerUrl: solanaTxUrl(finalTxSignature),
  };
}

// decision-relay's own PDA seeds — duplicated from solana-escrow.ts's
// identical constant rather than imported, matching that file's own
// stated discipline (no shared TS/Rust seed source exists yet); keep in
// lockstep with decision_relay_storage_pda_seeds!/escrow_authority
// seeds in chains/solana/programs/decision-relay/src/lib.rs if they
// ever change.
const ESCROW_AUTHORITY_SEEDS = [Buffer.from("decision_relay"), Buffer.from("-"), Buffer.from("escrow_authority")];

function deriveDecisionRelayEscrowAuthority(decisionRelayProgramId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(ESCROW_AUTHORITY_SEEDS, decisionRelayProgramId);
  return pda;
}
