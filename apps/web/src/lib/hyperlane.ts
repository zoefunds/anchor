import {
  dispatchDecisionRelay,
  dispatchDecisionRelayToSealevel,
  HYPERLANE_DOMAIN,
  type DecisionRelayPayload,
  type SealevelDecisionRelayPayload,
} from "@anchor/hyperlane-relay";
import type { Address, Hex } from "viem";
import { pad } from "viem";

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
  /** The contract's own evidence_hash (sha256 hex, no 0x prefix) — see adjudicator.py's adjudicate(). Required; a decision with no real evidence_hash shouldn't be relayed with a fabricated stand-in. Used only for local validation here — decisionHash below is what's actually carried on-chain as proofHash, since it's the field a destination can use to verify outcome/shares/policy, not just evidence binding. */
  evidenceHash: string;
  /** sha256 fingerprint of the full decision (case/policy ids, outcome, shares, reason codes, evidenceHash, contractCodeHash) — see adjudication-service.ts's computeDecisionHash. This is what's actually transmitted as DecisionRelay's proofHash field, so a destination can verify the settled outcome against the decision Anchor claims to have made, not just that some evidence existed. */
  decisionHash: string;
  /** Sealevel-only — see schema.prisma's settlementSolana* fields for why these can't reuse claimantRef/respondentRef/id. */
  settlementSolanaClaimant?: string | null;
  settlementSolanaRespondent?: string | null;
  settlementSolanaEscrowProgram?: string | null;
  settlementSolanaCaseId?: string | null;
}

/** Formats a sha256 hex digest (evidenceHash or decisionHash, no 0x prefix) as a bytes32 for DecisionRelay.sol. */
function hashToBytes32(hash: string, label: string): Hex {
  const hex = hash.startsWith("0x") ? hash.slice(2) : hash;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${label} must be a 32-byte hex string (sha256 hex digest), got: ${hash}`);
  }
  return `0x${hex}` as Hex;
}

const SEALEVEL_CHAINS = new Set(["solanatestnet"]);

/**
 * Dispatches a DecisionRelay Hyperlane message for a decided case with a
 * settlement target configured. "sepolia" dispatches to an EVM
 * DecisionRelay.sol recipient; "solanatestnet" dispatches to
 * decision-relay's Sealevel program, which requires the settlementSolana*
 * fields to be present (validated at case-creation time, see
 * api/cases/route.ts, but re-checked here since this function is the
 * actual trust boundary). Anything else throws rather than silently
 * no-opping, so a misconfigured case surfaces immediately instead of
 * quietly never settling.
 */
export async function dispatchDecisionForCase(params: DispatchDecisionParams): Promise<{ txHash: Hex; messageId: Hex }> {
  const config = getRelayConfig();

  if (params.settlementChain === "sepolia") {
    // Validate evidenceHash even though it isn't transmitted, so a
    // decision missing real evidence binding still fails loudly here
    // rather than only surfacing as a malformed decisionHash later.
    hashToBytes32(params.evidenceHash, "evidenceHash");
    const payload: DecisionRelayPayload = {
      caseId: params.caseId,
      outcome: params.outcome,
      claimantAmount: params.claimantAmountAtto,
      respondentAmount: params.respondentAmountAtto,
      escrowId: pad("0x0", { size: 32 }), // no real per-case escrow id modeled yet for EVM settlement — placeholder, see docs/hyperlane-integration.md open question #4
      proofHash: hashToBytes32(params.decisionHash, "decisionHash"),
    };
    return dispatchDecisionRelay(config, HYPERLANE_DOMAIN.sepolia, params.settlementContract as Address, payload);
  }

  if (SEALEVEL_CHAINS.has(params.settlementChain)) {
    if (
      !params.settlementSolanaClaimant ||
      !params.settlementSolanaRespondent ||
      !params.settlementSolanaEscrowProgram ||
      !params.settlementSolanaCaseId
    ) {
      throw new Error(
        `settlementChain "${params.settlementChain}" requires settlementSolanaClaimant/Respondent/EscrowProgram/CaseId to be set on the case`
      );
    }
    const payload: SealevelDecisionRelayPayload = {
      caseId: params.settlementSolanaCaseId,
      claimant: params.settlementSolanaClaimant,
      respondent: params.settlementSolanaRespondent,
      escrowProgram: params.settlementSolanaEscrowProgram,
      claimantShareBps: params.claimantShareBps,
      respondentShareBps: params.respondentShareBps,
    };
    return dispatchDecisionRelayToSealevel(config, HYPERLANE_DOMAIN.solanaTestnet, params.settlementContract, payload);
  }

  throw new Error(
    `unsupported settlementChain "${params.settlementChain}" — supported: sepolia, solanatestnet (see packages/hyperlane-relay)`
  );
}
