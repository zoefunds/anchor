import { createHash } from "crypto";
import { type Address, type Hex, createPublicClient, createWalletClient, http, isAddress, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/audit";
import { verifyEscrowVersionUnchanged, depositsAbiForVersion } from "@/lib/escrow-version";
import { caseIdToBytes32 } from "@/lib/emergency-refund";
import { normalizeSolanaAddress, checkAndConfirmSolanaDeposit } from "@/lib/solana-escrow";

// Item C (re-audit): the real CaseSettlement/SettlementIntegration
// creation workflow. Everything this session built before now
// (adjudicate → dispatch → escrow validation) assumed a CaseSettlement
// already existed with both party addresses correctly set — those rows
// were, in practice, created this session by hand (SSH + Prisma) with
// staff-pasted addresses. This module is the real, non-manual path:
// escrowId is derived, not chosen; each party sets their own address
// through their own token-authenticated identity, not staff typing it
// in; and a deposit is only ever confirmed by reading the escrow
// contract's own on-chain state, never trusted from a caller-supplied
// txHash.

const DECISION_RELAY_LOOKUP_ABI = [
  {
    type: "function",
    name: "decisionRelay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const DEPOSITED_EVENT_ABI = [
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "caseId", type: "bytes32", indexed: true },
      { name: "escrowId", type: "bytes32", indexed: true },
      { name: "depositor", type: "address", indexed: true },
      { name: "claimant", type: "address" },
      { name: "respondent", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
] as const;

const DEPOSIT_STATUS = { NONE: 0, DEPOSITED: 1, SETTLED: 2 } as const;

export class SettlementIntegrationError extends Error {}
export class CaseSettlementError extends Error {}
export class DepositConfirmationError extends Error {}

function getPublicClient(chain: string) {
  if (chain !== "sepolia") {
    throw new SettlementIntegrationError(`unsupported chain for on-chain verification: ${chain}`);
  }
  return createPublicClient({ chain: sepolia, transport: http(process.env.HYPERLANE_RELAY_RPC_URL) });
}

/**
 * Deterministic, non-guessable escrowId for a case — sha256(caseId),
 * 0x-prefixed. Never caller-chosen: a caller-chosen escrowId is exactly
 * how a case could accidentally (or deliberately) collide with, or be
 * pointed at, another case's deposit.
 */
export function deriveEscrowId(caseId: string): Hex {
  return `0x${createHash("sha256").update(caseId).digest("hex")}` as Hex;
}

/**
 * Chain-aware escrowId: for Solana, the escrow's own case-account PDA
 * is seeded by a caller-chosen string set at case-filing time
 * (Case.settlementSolanaCaseId — the party who deposits picks it when
 * calling initialize_case), NOT a value this app can derive on its
 * own the way deriveEscrowId's sha256 does for EVM. Using the wrong
 * one here would derive a PDA that never matches the real deposit.
 */
export function deriveEscrowIdForCase(kase: { id: string; settlementChain: string | null; settlementSolanaCaseId: string | null }): string {
  if (kase.settlementChain === "solanatestnet") {
    if (!kase.settlementSolanaCaseId) {
      throw new SettlementIntegrationError("case has no settlementSolanaCaseId set — required to bind a Solana settlement integration");
    }
    return kase.settlementSolanaCaseId;
  }
  return deriveEscrowId(kase.id);
}

const AUTHORIZE_DEPOSIT_ABI = [
  {
    type: "function",
    name: "authorizeDeposit",
    stateMutability: "nonpayable",
    inputs: [
      { name: "caseId", type: "bytes32" },
      { name: "escrowId", type: "bytes32" },
      { name: "claimant", type: "address" },
      { name: "respondent", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/**
 * Security-audit fix (finding #2, 2026-09-04): the real on-chain
 * pre-authorization Escrow.deposit() now requires before it will
 * accept anything for a given escrowId — see Escrow.sol's own header
 * for why (deterministic, publicly-computable escrowIds were otherwise
 * front-runnable/griefable). Called once both parties have set their
 * settlement address (see the settlement-address route), using the
 * same HYPERLANE_RELAY_PRIVATE_KEY-controlled wallet already trusted
 * as DecisionRelay's trustedSender and as this escrow's own
 * depositAuthorizer (set at deploy time — see DeployEscrow.s.sol).
 *
 * V1-only integrations have no authorizeDeposit() function at all
 * (it's a V2 addition) — this is a genuine no-op for those, not a
 * silently-skipped step, since V1's deposit() never gained the
 * authorization requirement in the first place. Solana's reference
 * escrow program (chains/solana/programs/escrow) has no pre-
 * authorization step either — the deposit happens atomically inside
 * initialize_case, called directly by the claimant with the adjudicator
 * PDA already fixed — so this is a genuine no-op there too, not a
 * missing feature.
 */
export async function authorizeDepositOnChain(caseSettlementId: string): Promise<
  | { outcome: "authorized"; txHash: string }
  | { outcome: "not_applicable_v1" }
  | { outcome: "not_applicable_solana" }
  | { outcome: "already_authorized" }
  | { outcome: "not_ready"; reason: string }
> {
  const cs = await prisma.caseSettlement.findUniqueOrThrow({
    where: { id: caseSettlementId },
    include: { integration: true, case: true },
  });

  if (cs.integration.chain === "solanatestnet") {
    return { outcome: "not_applicable_solana" };
  }
  if (cs.integration.escrowVersion === "V1") {
    return { outcome: "not_applicable_v1" };
  }
  if (cs.depositAuthorizedAt) {
    return { outcome: "already_authorized" };
  }
  if (!cs.claimantAddress || !cs.respondentAddress) {
    return { outcome: "not_ready", reason: "both parties must set their settlement address before authorization" };
  }
  if (cs.integration.chain !== "sepolia") {
    throw new SettlementIntegrationError(`unsupported chain for on-chain deposit authorization: ${cs.integration.chain}`);
  }

  const privateKey = process.env.HYPERLANE_RELAY_PRIVATE_KEY;
  if (!privateKey) {
    throw new SettlementIntegrationError("HYPERLANE_RELAY_PRIVATE_KEY is not set — see apps/web/.env.example");
  }
  const account = privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex);
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(process.env.HYPERLANE_RELAY_RPC_URL) });

  const escrowIdBytes32 = deriveEscrowId(cs.caseId);
  const caseIdBytes32 = caseIdToBytes32(cs.caseId);

  const txHash = await walletClient.writeContract({
    address: cs.integration.escrowContractAddress as Address,
    abi: AUTHORIZE_DEPOSIT_ABI,
    functionName: "authorizeDeposit",
    args: [caseIdBytes32, escrowIdBytes32, cs.claimantAddress as Address, cs.respondentAddress as Address, BigInt(cs.expectedAmountAtto)],
  });

  // Real bug found and fixed 2026-09-12: writeContract only submits the
  // transaction — it does not confirm it landed. A caller that proceeds
  // straight to a deposit() call (executeEvmDeposit does exactly this)
  // can simulate/submit deposit() against on-chain state from BEFORE
  // this authorization was actually mined, hitting a real
  // NotAuthorized(bytes32) revert even though authorizeDeposit()
  // eventually succeeds. Confirming here closes that race for every
  // caller, not just the one that happened to expose it.
  const publicClient = createPublicClient({ chain: sepolia, transport: http(process.env.HYPERLANE_RELAY_RPC_URL) });
  await publicClient.waitForTransactionReceipt({ hash: txHash });

  await prisma.$transaction(async (tx) => {
    await tx.caseSettlement.update({
      where: { id: cs.id },
      data: { depositAuthorizedAt: new Date(), depositAuthorizeTxHash: txHash },
    });
    await logAction(
      {
        organizationId: cs.case.organizationId,
        action: "case_settlement.deposit_authorized",
        targetType: "CaseSettlement",
        targetId: cs.id,
        metadata: { caseId: cs.caseId, escrowId: escrowIdBytes32, txHash, expectedAmountAtto: cs.expectedAmountAtto },
      },
      tx
    );
  });

  return { outcome: "authorized", txHash };
}

/**
 * Real pre-bind check: an org creating a SettlementIntegration could
 * paste in ANY address as escrowContractAddress, including one that
 * isn't actually wired to the case's DecisionRelay at all — deposits
 * into it would look fine right up until settlement, when
 * DecisionRelay would simply never be able to call settle() on it (or
 * worse, would call settle() on a DIFFERENT contract than the one the
 * app just verified a deposit in — the exact class of bug Phase 1's
 * assertSettlementTargetMatchesIntegration closes at dispatch time).
 * This closes the same gap earlier, at bind time: read the escrow
 * contract's own immutable decisionRelay() and require it to equal
 * the case's actual settlementContract.
 */
export async function assertEscrowBoundToDecisionRelay(params: {
  chain: string;
  escrowContractAddress: Address;
  expectedDecisionRelayAddress: Address;
}): Promise<void> {
  const client = getPublicClient(params.chain);
  const liveDecisionRelay = await client.readContract({
    address: params.escrowContractAddress,
    abi: DECISION_RELAY_LOOKUP_ABI,
    functionName: "decisionRelay",
  });
  if (liveDecisionRelay.toLowerCase() !== params.expectedDecisionRelayAddress.toLowerCase()) {
    throw new SettlementIntegrationError(
      `escrow ${params.escrowContractAddress}'s decisionRelay() is ${liveDecisionRelay}, not the case's own settlementContract ${params.expectedDecisionRelayAddress} — refusing to bind a case to an escrow the relay cannot actually settle`
    );
  }
}

/**
 * Real, on-chain-authoritative deposit confirmation. Never trusts a
 * caller-supplied txHash or amount — reads Escrow.deposits(escrowId)
 * directly (the same read Phase 1's assertEscrowDepositMatches uses at
 * dispatch time) and only transitions PENDING_DEPOSIT → DEPOSITED when
 * the live on-chain claimant/respondent/amount exactly match what both
 * parties themselves set. The Deposited event log is used only to
 * recover a real depositTxHash for the record — the confirmation
 * decision itself never depends on the log, only on the contract's own
 * current state.
 */
export async function checkAndConfirmDeposit(caseSettlementId: string): Promise<
  | { outcome: "confirmed"; txHash: string }
  | { outcome: "not_ready"; reason: string }
  | { outcome: "no_deposit_yet" }
  | { outcome: "already_confirmed" }
> {
  const cs = await prisma.caseSettlement.findUnique({
    where: { id: caseSettlementId },
    include: { integration: true, case: true },
  });
  if (!cs) throw new CaseSettlementError(`CaseSettlement ${caseSettlementId} not found`);
  if (cs.status === "DEPOSITED" || cs.status === "SETTLED") {
    return { outcome: "already_confirmed" };
  }
  if (!cs.claimantAddress || !cs.respondentAddress) {
    return { outcome: "not_ready", reason: "both parties must set their settlement address before a deposit can be confirmed" };
  }

  if (cs.integration.chain === "solanatestnet") {
    const result = await checkAndConfirmSolanaDeposit({
      escrowProgramId: cs.integration.escrowContractAddress,
      onChainCaseId: cs.escrowId,
      expectedClaimant: cs.claimantAddress,
      expectedRespondent: cs.respondentAddress,
      expectedAmountLamports: BigInt(cs.expectedAmountAtto),
    });
    if (result.outcome === "no_deposit_yet") return { outcome: "no_deposit_yet" };
    if (result.outcome === "mismatch") return { outcome: "not_ready", reason: result.reason };

    await prisma.$transaction(async (tx) => {
      await tx.caseSettlement.update({
        where: { id: cs.id },
        data: { status: "DEPOSITED", depositConfirmedAt: new Date() },
      });
      await logAction(
        {
          organizationId: cs.case.organizationId,
          action: "case_settlement.deposit_confirmed",
          targetType: "CaseSettlement",
          targetId: cs.id,
          metadata: { caseId: cs.caseId, escrowId: cs.escrowId, depositedAmountLamports: result.depositedAmountLamports.toString() },
        },
        tx
      );
    });
    return { outcome: "confirmed", txHash: "" };
  }

  if (cs.integration.escrowVersion === "SOLANA_V1") {
    // Unreachable in practice (chain and escrowVersion are set together
    // at registration time — see settlement-integrations/route.ts), but
    // guarded explicitly rather than assumed, and narrows the type for
    // the EVM-only calls below.
    throw new SettlementIntegrationError(`CaseSettlement ${cs.id} has escrowVersion SOLANA_V1 but chain ${cs.integration.chain} — inconsistent integration record`);
  }

  // Priority 2: re-verify the live contract still behaves like the
  // version this integration was registered against before decoding
  // anything — never assume the ABI from which address is configured.
  await verifyEscrowVersionUnchanged({
    integrationId: cs.integrationId,
    escrowContractAddress: cs.integration.escrowContractAddress as Address,
    expectedVersion: cs.integration.escrowVersion,
  });

  const client = getPublicClient(cs.integration.chain);
  const escrowIdBytes32 = deriveEscrowId(cs.caseId);
  const [status, claimant, respondent, amount] = (await client.readContract({
    address: cs.integration.escrowContractAddress as Address,
    abi: depositsAbiForVersion(cs.integration.escrowVersion),
    functionName: "deposits",
    args: [escrowIdBytes32],
  })) as readonly [number, Address, Address, bigint, ...unknown[]];

  if (status === DEPOSIT_STATUS.NONE) {
    return { outcome: "no_deposit_yet" };
  }
  if (claimant.toLowerCase() !== cs.claimantAddress.toLowerCase()) {
    return { outcome: "not_ready", reason: `on-chain deposit claimant ${claimant} does not match the address the claimant set (${cs.claimantAddress})` };
  }
  if (respondent.toLowerCase() !== cs.respondentAddress.toLowerCase()) {
    return { outcome: "not_ready", reason: `on-chain deposit respondent ${respondent} does not match the address the respondent set (${cs.respondentAddress})` };
  }
  if (amount.toString() !== cs.expectedAmountAtto) {
    return { outcome: "not_ready", reason: `on-chain deposit amount ${amount} does not match the expected amount ${cs.expectedAmountAtto}` };
  }

  // Best-effort real txHash lookup for the audit record — a bounded
  // recent-block log scan, not a correctness dependency (the state
  // read above already proved the deposit is real and matches).
  let txHash: string | null = null;
  try {
    const latestBlock = await client.getBlockNumber();
    const fromBlock = latestBlock > 50_000n ? latestBlock - 50_000n : 0n;
    const logs = await client.getLogs({
      address: cs.integration.escrowContractAddress as Address,
      event: DEPOSITED_EVENT_ABI[0],
      args: { escrowId: escrowIdBytes32 },
      fromBlock,
      toBlock: latestBlock,
    });
    txHash = logs.length > 0 ? logs[logs.length - 1].transactionHash : null;
  } catch {
    txHash = null;
  }

  await prisma.$transaction(async (tx) => {
    await tx.caseSettlement.update({
      where: { id: cs.id },
      data: { status: "DEPOSITED", depositTxHash: txHash, depositConfirmedAt: new Date() },
    });
    await logAction(
      {
        organizationId: cs.case.organizationId,
        action: "case_settlement.deposit_confirmed",
        targetType: "CaseSettlement",
        targetId: cs.id,
        metadata: { caseId: cs.caseId, escrowId: escrowIdBytes32, txHash, amount: cs.expectedAmountAtto },
      },
      tx
    );
  });

  return { outcome: "confirmed", txHash: txHash ?? "" };
}

/** EIP-55/lowercase-tolerant EVM address validation shared by both the org-facing and party-facing binding routes. */
export function normalizeEvmAddress(raw: unknown): Address | null {
  if (typeof raw !== "string" || !isAddress(raw)) return null;
  return getAddress(raw);
}

/** Chain-aware settlement address normalization — routes to normalizeEvmAddress or Solana's base58-pubkey check depending on which chain the case actually settles through, so a party's public settlement-address route doesn't have to know or guess. */
export function normalizeSettlementAddress(chain: string, raw: unknown): string | null {
  if (chain === "solanatestnet") return normalizeSolanaAddress(raw);
  return normalizeEvmAddress(raw);
}
