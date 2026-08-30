import {
  dispatchDecisionRelay,
  HYPERLANE_DOMAIN,
  type DecisionRelayPayload,
} from "@anchor/hyperlane-relay";
import type { Address, Hex } from "viem";
import { keccak256, toHex, pad } from "viem";

// GenLayer isn't a Hyperlane domain (checked - not supported by Hyperlane
// or LayerZero), so Anchor's backend dispatches the DecisionRelay message
// itself from an EVM chain it controls, on the decided case's behalf. The
// signer is the same funded EVM key used to deploy DecisionRelay.sol and
// run the self-hosted relayer (see chains/hyperlane-relayer/README.md) -
// one wallet plays "GenLayer's relay origin" for now, not a production
// posture, but consistent with the rest of this MVP's trust model.
function getRelayConfig() {
  const privateKey = process.env.HYPERLANE_RELAY_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("HYPERLANE_RELAY_PRIVATE_KEY is not set — see apps/web/.env.example");
  }
  return {
    originChain: "sepolia" as const,
    privateKey: (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex,
    rpcUrl: process.env.HYPERLANE_RELAY_RPC_URL,
  };
}

export interface DispatchDecisionParams {
  caseId: string;
  outcome: string;
  claimantShareBps: number;
  respondentShareBps: number;
  claimantAmountAtto: bigint;
  respondentAmountAtto: bigint;
  settlementChain: string;
  settlementContract: string;
}

/** caseId is an arbitrary cuid string, doesn't fit bytes32 directly — hash it, same discipline DecisionRelay.sol's caller-side encoding already assumed. */
function caseIdToBytes32(caseId: string): Hex {
  return keccak256(toHex(caseId));
}

/**
 * Dispatches a DecisionRelay Hyperlane message for a decided case with a
 * settlement target configured. Only "sepolia" is wired as a destination
 * today (matches HYPERLANE_DOMAIN/HYPERLANE_MAILBOX in
 * packages/hyperlane-relay) - anything else throws rather than silently
 * no-opping, so a misconfigured case surfaces immediately instead of
 * quietly never settling.
 */
export async function dispatchDecisionForCase(params: DispatchDecisionParams): Promise<{ txHash: Hex; messageId: Hex }> {
  if (params.settlementChain !== "sepolia") {
    throw new Error(
      `unsupported settlementChain "${params.settlementChain}" — only "sepolia" is wired today (see packages/hyperlane-relay)`
    );
  }
  const destinationDomain = HYPERLANE_DOMAIN.sepolia;

  const payload: DecisionRelayPayload = {
    caseId: params.caseId,
    outcome: params.outcome,
    claimantAmount: params.claimantAmountAtto,
    respondentAmount: params.respondentAmountAtto,
    escrowId: pad("0x0", { size: 32 }), // no real per-case escrow id modeled yet — placeholder, see docs/hyperlane-integration.md open question #4
    proofHash: caseIdToBytes32(params.caseId),
  };

  return dispatchDecisionRelay(
    getRelayConfig(),
    destinationDomain,
    params.settlementContract as Address,
    payload
  );
}
