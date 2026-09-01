import {
  dispatchDecisionRelay,
  computeDecisionAttestationHash,
  caseIdToBytes32,
  HYPERLANE_DOMAIN,
  type DecisionRelayPayload,
} from "@anchor/hyperlane-relay";
import type { Address, Hex } from "viem";
import { pad, createPublicClient, http, recoverAddress } from "viem";
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

const ATTESTOR_THRESHOLD_ABI = [
  {
    type: "function",
    name: "attestorThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "isAttestor",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export function getEvmPublicClient() {
  return createPublicClient({ chain: sepolia, transport: http(process.env.HYPERLANE_RELAY_RPC_URL) });
}

/** Reads DecisionRelay.sol's own attestorThreshold() — the source of truth for "how many signatures are actually needed," so this never drifts out of sync with whatever the deployed contract currently requires (e.g. after a setAttestorThreshold governance change). */
export async function getAttestorThreshold(relayAddress: Address): Promise<number> {
  const count = await getEvmPublicClient().readContract({
    address: relayAddress,
    abi: ATTESTOR_THRESHOLD_ABI,
    functionName: "attestorThreshold",
  });
  return Number(count);
}

/** Reads DecisionRelay.sol's own isAttestor(address) — used to reject a submitted co-signature from an address that isn't (or is no longer) a registered attestor, before it's ever stored. */
export async function isRegisteredAttestor(relayAddress: Address, signer: Address): Promise<boolean> {
  return getEvmPublicClient().readContract({
    address: relayAddress,
    abi: ATTESTOR_THRESHOLD_ABI,
    functionName: "isAttestor",
    args: [signer],
  });
}

/**
 * Recovers the signer of every signature over `hash`, revalidates EACH
 * one against the contract's LIVE isAttestor mapping (not a cached
 * assumption), and returns the count of DISTINCT valid registered
 * signers — never raw signature count or array length. A re-audit
 * correctly flagged that comparing array length to threshold is wrong
 * on two counts: (1) the same signer's signature could appear more than
 * once (duplicate bytes, or a different valid (r,s,v) encoding of the
 * same signature — normalizing by RECOVERED ADDRESS rather than raw
 * signature bytes closes both), and (2) a signature from an attestor
 * governance has since removed via removeAttestor must stop counting
 * immediately, which only a live isAttestor check (not a locally cached
 * assumption) can guarantee — mirrors DecisionRelay.sol's own
 * `_countValidDistinctAttestations` exactly, so the backend's local
 * "is this enough" check can never disagree with what the contract
 * will actually accept.
 */
export async function countValidDistinctSigners(
  relayAddress: Address,
  hash: Hex,
  signatures: Hex[]
): Promise<{ validCount: number; distinctSigners: Address[] }> {
  const recovered = await Promise.all(
    signatures.map(async (signature) => {
      try {
        return await recoverAddress({ hash, signature });
      } catch {
        return null; // malformed signature — never counts, never crashes the whole check
      }
    })
  );

  const uniqueCandidates = [...new Set(recovered.filter((a): a is Address => a !== null).map((a) => a.toLowerCase()))];
  const membership = await Promise.all(uniqueCandidates.map((addr) => isRegisteredAttestor(relayAddress, addr as Address)));

  const distinctSigners = uniqueCandidates.filter((_, i) => membership[i]) as Address[];
  return { validCount: distinctSigners.length, distinctSigners };
}

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

// Deliberately DIFFERENT keys from HYPERLANE_RELAY_PRIVATE_KEY above —
// see DecisionRelay.sol's own doc comment on `isAttestor`/`attestorThreshold`
// for why. The dispatch key only needs to pay gas and call
// Mailbox.dispatch; the attestor keys are the actual thing standing
// behind "this decision is real," so this backend process holds
// whichever subset of the M-of-N set it's configured with (real
// production deployments should split custody of the full set across
// separate holders/processes — see docs/multisig-attestor-setup.md — a
// single process holding every key defeats the point of M-of-N).
// ATTESTOR_PRIVATE_KEYS is a comma-separated list (each entry the same
// 0x-prefixed hex format ATTESTOR_PRIVATE_KEY used to be); the old
// singular ATTESTOR_PRIVATE_KEY is still read as a one-key fallback so a
// deployment that hasn't rotated to the multisig contract yet keeps
// working unchanged.
function getAttestorAccounts() {
  const list = process.env.ATTESTOR_PRIVATE_KEYS;
  const single = process.env.ATTESTOR_PRIVATE_KEY;
  const raw = list
    ? list.split(",").map((k) => k.trim()).filter(Boolean)
    : single
      ? [single]
      : [];
  if (raw.length === 0) {
    throw new Error("ATTESTOR_PRIVATE_KEYS (or ATTESTOR_PRIVATE_KEY) is not set — see apps/web/.env.example");
  }
  return raw.map((privateKey) => privateKeyToAccount((privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex));
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
  /** Signatures already collected from EXTERNAL attestors (not held by this backend) for this exact decision's attestation hash — see Decision.pendingAttestationSignatures. Combined with whatever the backend signs itself; if the combined total still doesn't reach attestorThreshold, dispatchDecisionForCase throws InsufficientAttestorSignaturesError instead of a hard failure. */
  externalAttestationSignatures?: Hex[];
  /** Sealevel-only equivalent of externalAttestationSignatures above — {publicKey, signature} pairs already collected from external Solana attestors (see Decision.pendingSolanaAttestations). Solana's Ed25519 signatures aren't recoverable, so each entry must carry its signer's public key explicitly. */
  externalSolanaAttestations?: { publicKey: Uint8Array; signature: Uint8Array }[];
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
 * Thrown when the backend's own ATTESTOR_PRIVATE_KEYS, combined with
 * whatever externalAttestationSignatures the caller already supplied,
 * still don't reach the deployed contract's attestorThreshold — expected
 * and NOT a bug once real key custody is split (see
 * docs/multisig-attestor-setup.md): it means dispatch is genuinely
 * waiting on an independent attestor's signature, not that anything is
 * broken. Callers should persist attestationHash (see
 * adjudication-service.ts's dispatchSettlementForDecision) so a
 * signature submitted later via POST
 * /api/internal/pending-attestations/[decisionId]/sign can complete the
 * same dispatch without recomputing anything.
 */
export class InsufficientAttestorSignaturesError extends Error {
  constructor(
    public readonly attestationHash: Hex,
    public readonly collectedCount: number,
    public readonly threshold: number
  ) {
    super(`only ${collectedCount} of ${threshold} required attestor signatures available for hash ${attestationHash}`);
    this.name = "InsufficientAttestorSignaturesError";
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
    const backendSignatures = await Promise.all(
      getAttestorAccounts().map((account) => account.sign({ hash: attestationHash }))
    );
    const attestationSignatures = [...backendSignatures, ...(params.externalAttestationSignatures ?? [])];

    const threshold = await getAttestorThreshold(params.settlementContract as Address);
    // Threshold sufficiency is determined by DISTINCT valid registered
    // signers recovered from the actual signatures — never by raw
    // array length (see countValidDistinctSigners's own doc comment for
    // the two ways length alone lies: duplicate/re-encoded signatures
    // from one signer, and stale signatures from an attestor governance
    // has since removed).
    const { validCount } = await countValidDistinctSigners(params.settlementContract as Address, attestationHash, attestationSignatures);
    if (validCount < threshold) {
      throw new InsufficientAttestorSignaturesError(attestationHash, validCount, threshold);
    }

    const payload: DecisionRelayPayload = {
      caseId: params.caseId,
      outcome: params.outcome,
      claimantAmount: params.claimantAmountAtto,
      respondentAmount: params.respondentAmountAtto,
      escrowId,
      proofHash: decisionHashBytes32,
      attestationSignatures,
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
      rpcUrl,
      params.externalSolanaAttestations ?? []
    );
    return { txHash: signature, messageId: signature };
  }

  throw new Error(
    `unsupported settlementChain "${params.settlementChain}" — supported: sepolia, solanatestnet (see packages/hyperlane-relay)`
  );
}
