import type { Address, Hex } from "viem";
import { getEvmPublicClient } from "@/lib/hyperlane";

// Real fix for this session's core P0 finding: dispatchDecisionForCase
// used to hardcode escrowId to a zero placeholder because no contract
// implementing DecisionRelay's ISettlementTarget existed to validate
// against — see chains/evm/contracts/Escrow.sol (deployed to Sepolia at
// 0x5314725C32b58d0e1CACa510d491c8492D0BE997, verified live via
// `decisionRelay()` returning the real DecisionRelay address this
// session). This module reads that contract's real on-chain deposit
// state and validates it against what a case's CaseSettlement record
// claims, before dispatch is ever allowed to proceed.

const ESCROW_ABI = [
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
    ],
  },
] as const;

const DEPOSIT_STATUS = { NONE: 0, DEPOSITED: 1, SETTLED: 2 } as const;

export class EscrowValidationError extends Error {}

/**
 * Reads Escrow.deposits(escrowId) directly from chain and throws
 * EscrowValidationError with a specific reason if it doesn't exactly
 * match what CaseSettlement claims — never a soft warning. This is the
 * real trust boundary: a case's DB row asserting "this escrow has
 * these parties and this amount" means nothing until it's checked
 * against what was actually deposited on-chain.
 */
export async function assertEscrowDepositMatches(params: {
  escrowContractAddress: Address;
  escrowIdBytes32: Hex;
  expectedClaimant: Address;
  expectedRespondent: Address;
  expectedTotalAmountWei: bigint;
}): Promise<void> {
  const client = getEvmPublicClient();
  const [status, claimant, respondent, amount] = await client.readContract({
    address: params.escrowContractAddress,
    abi: ESCROW_ABI,
    functionName: "deposits",
    args: [params.escrowIdBytes32],
  });

  if (status === DEPOSIT_STATUS.NONE) {
    throw new EscrowValidationError(`escrow ${params.escrowIdBytes32} has no deposit on ${params.escrowContractAddress} — nothing to settle against`);
  }
  if (status === DEPOSIT_STATUS.SETTLED) {
    throw new EscrowValidationError(`escrow ${params.escrowIdBytes32} on ${params.escrowContractAddress} is already SETTLED — refusing to dispatch a duplicate settlement`);
  }
  if (claimant.toLowerCase() !== params.expectedClaimant.toLowerCase()) {
    throw new EscrowValidationError(
      `escrow ${params.escrowIdBytes32} claimant mismatch: on-chain deposit names ${claimant}, CaseSettlement expects ${params.expectedClaimant}`
    );
  }
  if (respondent.toLowerCase() !== params.expectedRespondent.toLowerCase()) {
    throw new EscrowValidationError(
      `escrow ${params.escrowIdBytes32} respondent mismatch: on-chain deposit names ${respondent}, CaseSettlement expects ${params.expectedRespondent}`
    );
  }
  if (amount !== params.expectedTotalAmountWei) {
    throw new EscrowValidationError(
      `escrow ${params.escrowIdBytes32} amount mismatch: on-chain deposit holds ${amount} wei, CaseSettlement expects ${params.expectedTotalAmountWei} wei`
    );
  }
}
