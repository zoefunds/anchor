import {
  dispatchDecisionRelay,
  computeDecisionAttestationHash,
  caseIdToBytes32,
  HYPERLANE_DOMAIN,
  type DecisionRelayPayload,
} from "@anchor/hyperlane-relay";
import type { Address, Hex } from "viem";
import { pad, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const PROCESSED_DECISIONS_ABI = [
  {
    type: "function",
    name: "processedDecisions",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

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

// Deliberately a DIFFERENT key from HYPERLANE_RELAY_PRIVATE_KEY above —
// see DecisionRelay.sol's own doc comment on `attestor` for why. The
// dispatch key only needs to pay gas and call Mailbox.dispatch; the
// attestor key is the actual thing standing behind "this decision is
// real," so it should be held more carefully (e.g. real deployments
// should consider generating this offline and never storing it in the
// same secrets store as the day-to-day relay key) even though this MVP
// currently keeps both as ordinary env vars.
function getAttestorAccount() {
  const privateKey = process.env.ATTESTOR_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("ATTESTOR_PRIVATE_KEY is not set — see apps/web/.env.example");
  }
  return privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex);
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

/** Thrown when reconciliation (see isDecisionSettledOnSepolia below) finds the destination contract already marked this exact decision settled — a prior dispatch's transaction landed even though Anchor's own record of it (relayTxHash) never got written, e.g. a crash between the on-chain call succeeding and the DB update. Distinct from a normal dispatch failure so the caller can record "already settled, no local txHash to show" instead of treating this as an error to keep retrying. */
export class DecisionAlreadySettledError extends Error {
  constructor(decisionHash: string) {
    super(`decision ${decisionHash} is already marked processed on the destination contract`);
    this.name = "DecisionAlreadySettledError";
  }
}

/**
 * Destination-side reconciliation: checks DecisionRelay.sol's own
 * processedDecisions(bytes32) mapping (see the contract's idempotency
 * guard) before dispatching, so a retry after a lost local record (the
 * relay transaction succeeded but this process crashed or the DB write
 * failed before relayTxHash was saved) doesn't even attempt a redundant
 * send — it can only ever be rejected on-chain anyway, but checking
 * first avoids wasting a real transaction and gas on a guaranteed
 * revert, and gives the caller a clean signal to stop retrying.
 */
async function isDecisionSettledOnSepolia(settlementContract: Address, decisionHashBytes32: Hex): Promise<boolean> {
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.HYPERLANE_RELAY_RPC_URL) });
  return client.readContract({
    address: settlementContract,
    abi: PROCESSED_DECISIONS_ABI,
    functionName: "processedDecisions",
    args: [decisionHashBytes32],
  });
}

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
export async function dispatchDecisionForCase(params: DispatchDecisionParams): Promise<{ txHash: string; messageId: string }> {
  const config = getRelayConfig();

  if (params.settlementChain === "sepolia") {
    // Validate evidenceHash even though it isn't transmitted, so a
    // decision missing real evidence binding still fails loudly here
    // rather than only surfacing as a malformed decisionHash later.
    hashToBytes32(params.evidenceHash, "evidenceHash");
    const decisionHashBytes32 = hashToBytes32(params.decisionHash, "decisionHash");

    if (await isDecisionSettledOnSepolia(params.settlementContract as Address, decisionHashBytes32)) {
      throw new DecisionAlreadySettledError(params.decisionHash);
    }

    const escrowId = pad("0x0", { size: 32 }); // no real per-case escrow id modeled yet for EVM settlement — placeholder, see docs/hyperlane-integration.md open question #4
    const attestationHash = computeDecisionAttestationHash({
      originDomain: HYPERLANE_DOMAIN.sepolia,
      recipientAddress: params.settlementContract as Address,
      caseIdBytes32: caseIdToBytes32(params.caseId),
      outcome: params.outcome,
      claimantAmount: params.claimantAmountAtto,
      respondentAmount: params.respondentAmountAtto,
      escrowId,
      proofHash: decisionHashBytes32,
    });
    const attestationSignature = await getAttestorAccount().sign({ hash: attestationHash });

    const payload: DecisionRelayPayload = {
      caseId: params.caseId,
      outcome: params.outcome,
      claimantAmount: params.claimantAmountAtto,
      respondentAmount: params.respondentAmountAtto,
      escrowId,
      proofHash: decisionHashBytes32,
      attestationSignature,
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
    // Settlement itself is submitted directly (submitAttestedSettle), NOT
    // via Hyperlane — see decision-relay's attested_settle doc comment
    // for why Hyperlane delivery alone can no longer authorize moving
    // funds on this chain (no way to attach an Ed25519 attestation
    // verification instruction to a transaction the Hyperlane relayer
    // binary builds itself). The Hyperlane dispatch path
    // (dispatchDecisionRelayToSealevel) still exists and remains a valid
    // way to deliver a notification-only record, but this function's
    // job is settling real funds, so it calls the real settlement path.
    const rpcUrl = process.env.SOLANA_RPC_URL;
    if (!rpcUrl) {
      throw new Error("SOLANA_RPC_URL is not set — see apps/web/.env.example");
    }
    const { submitAttestedSettle } = await import("@/lib/solana-settle");
    const { signature } = await submitAttestedSettle(
      {
        decisionRelayProgramId: params.settlementContract,
        caseId: params.settlementSolanaCaseId,
        claimant: params.settlementSolanaClaimant,
        respondent: params.settlementSolanaRespondent,
        escrowProgram: params.settlementSolanaEscrowProgram,
        claimantShareBps: params.claimantShareBps,
        respondentShareBps: params.respondentShareBps,
        decisionHash: Buffer.from(hashToBytes32(params.decisionHash, "decisionHash").slice(2), "hex"),
      },
      rpcUrl
    );
    return { txHash: signature, messageId: signature };
  }

  throw new Error(
    `unsupported settlementChain "${params.settlementChain}" — supported: sepolia, solanatestnet (see packages/hyperlane-relay)`
  );
}
