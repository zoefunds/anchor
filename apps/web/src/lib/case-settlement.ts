import { createHash } from "crypto";
import { type Address, type Hex, createPublicClient, http, isAddress, getAddress } from "viem";
import { sepolia } from "viem/chains";
import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/audit";

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

const ESCROW_ABI = [
  {
    type: "function",
    name: "decisionRelay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "deposits",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "status", type: "uint8" },
      { name: "claimant", type: "address" },
      { name: "respondent", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "caseId", type: "bytes32" },
    ],
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
    abi: ESCROW_ABI,
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

  const client = getPublicClient(cs.integration.chain);
  const escrowIdBytes32 = deriveEscrowId(cs.caseId);
  const [status, claimant, respondent, amount] = await client.readContract({
    address: cs.integration.escrowContractAddress as Address,
    abi: ESCROW_ABI,
    functionName: "deposits",
    args: [escrowIdBytes32],
  });

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
