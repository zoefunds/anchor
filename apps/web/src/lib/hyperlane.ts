import {
  dispatchDecisionRelay,
  dispatchDecisionRelayToSealevel,
  computeDecisionAttestationHash,
  caseIdToBytes32,
  HYPERLANE_DOMAIN,
  type DecisionRelayPayload,
} from "@anchor/hyperlane-relay";
import type { Address, Hex } from "viem";
import { pad, isHex, createPublicClient, http, recoverAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { prisma } from "@/lib/prisma";
import { getUsdcBinding } from "@/lib/environment-registry";

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

// viem's http() transport has no default timeout — an RPC that hangs
// (rather than erroring) would hang settlement dispatch indefinitely.
// `retryCount: 0` because withDbRetry/retryFailedSettlements already own
// retry semantics at the call-site level; retrying here too would hide
// the real duration of an RPC failure from that layer.
const EVM_RPC_TIMEOUT_MS = 15_000;

export function getEvmPublicClient() {
  return createPublicClient({
    chain: sepolia,
    transport: http(process.env.HYPERLANE_RELAY_RPC_URL, { timeout: EVM_RPC_TIMEOUT_MS, retryCount: 0 }),
  });
}

// --- Approved settlement targets ---
// Real P0 fixed here (found by an external audit, twice): case creation
// used to accept an arbitrary caller-provided settlementContract/
// settlementSolanaEscrowProgram with no validation against anything this
// project actually deployed. Combined with escrowId being a hardcoded
// zero placeholder (see dispatchDecisionForCase below — that half of the
// finding is NOT fixed by this allowlist; there is still no real
// per-case on-chain escrow binding, so this remains "notification +
// attested settlement to a known contract," not a general escrow release
// flow), an arbitrary address meant a caller could point "settlement" at
// literally any contract/program, not just this project's own deployment.
// This does not build the real escrow-adapter model the audit correctly
// asks for (approved integration records, per-case escrow IDs,
// asset/party/amount/state validation) — that's a real, larger follow-up.
// It does close the immediate hole: only known, operator-approved
// addresses can be used as a settlement target at all. Defaults to this
// project's own real deployed addresses (recorded in
// chains/hyperlane-validator/deployment.json and confirmed live via
// `solana program show` this session) so existing legitimate dispatches
// keep working; override via env for a genuinely new approved
// integration, never by loosening this to "anything."
//
// 2026-09-07: this default had drifted to a stale DecisionRelay address
// (0x94f3FF55...) that no longer matches the live contract — exactly the
// class of doc/code drift apps/web/scripts/generate-deployment-manifest.ts
// exists to catch. Corrected against that script's live on-chain read
// (owner/attestorThreshold/codehash all verified against the real Safe).
// Production already sets APPROVED_SEPOLIA_SETTLEMENT_CONTRACTS via env,
// so this default only matters for local/staging environments without
// that override — but a wrong default there fails closed (rejects
// legitimate case creation) rather than open, which is why this went
// unnoticed rather than causing a security incident.
const DEFAULT_APPROVED_SEPOLIA_SETTLEMENT_CONTRACTS = ["0x1fc130416Dc09dff60e0Ea3C8dE8474e8428b3E2"];
const DEFAULT_APPROVED_SOLANA_SETTLEMENT_PROGRAMS = ["DGWSTw1PLsRbndb8spVkrtu3hfH599tRRBJ1JhVBbpVN"];
// The escrow program actually invoked to move funds on Solana settlement
// (see solana-settle.ts's submitAttestedSettle) — a separate, even more
// sensitive address than the decision-relay program above, and it was
// equally unvalidated caller input before this fix.
const DEFAULT_APPROVED_SOLANA_ESCROW_PROGRAMS = ["825aV7GJ31cjeTDycH1woKiaC95soJUYkKvZNFMugeZn"];

function parseApprovedList(envValue: string | undefined, fallback: string[]): Set<string> {
  const raw = envValue?.trim() ? envValue.split(",").map((s) => s.trim()).filter(Boolean) : fallback;
  return new Set(raw.map((s) => s.toLowerCase()));
}

/**
 * Whether `address` is an operator-approved settlement target for
 * `chain` ("sepolia" or a Solana chain name). Case creation must reject
 * anything not in this set — see api/cases/route.ts.
 */
export function isApprovedSettlementContract(chain: string, address: string): boolean {
  if (chain === "sepolia") {
    return parseApprovedList(process.env.APPROVED_SEPOLIA_SETTLEMENT_CONTRACTS, DEFAULT_APPROVED_SEPOLIA_SETTLEMENT_CONTRACTS).has(
      address.toLowerCase()
    );
  }
  // Solana addresses are base58 and case-sensitive — do not lowercase.
  const approved = process.env.APPROVED_SOLANA_SETTLEMENT_PROGRAMS?.trim()
    ? process.env.APPROVED_SOLANA_SETTLEMENT_PROGRAMS.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_APPROVED_SOLANA_SETTLEMENT_PROGRAMS;
  return approved.includes(address);
}

// Track 2 — USDC settlement targets are gated through a SEPARATE
// allowlist from isApprovedSettlementContract above, deliberately: a
// USDC EscrowUSDC deployment and a native-ETH Escrow deployment are
// never interchangeable (settling a USDC case against an ETH escrow's
// address, or vice versa, would be a real fund-safety bug, not merely
// a config error), so conflating the two lists would make that mistake
// possible even with both defaults present. Empty by default —
// EscrowUSDC has not been deployed to Sepolia by this change (see
// chains/evm/deploy/DeployEscrowUSDC.s.sol) — override via env once a
// real deployment exists.
const DEFAULT_APPROVED_SEPOLIA_USDC_ESCROWS: string[] = [];

/**
 * Track 2, item 1 — "reject arbitrary ERC-20 token addresses" and
 * "only this specific registry-bound USDC escrow can ever be a
 * settlement target." Both `escrowAddress` (the ISettlementTarget
 * contract) AND `tokenAddress` (the ERC-20 it was deployed against)
 * must match this environment's single bound USDC deployment — an
 * otherwise-approved escrow address paired with a DIFFERENT token
 * address is rejected too, since that combination could never be the
 * real, verified EscrowUSDC deployment this allowlist means to name.
 */
export function isApprovedUsdcEscrow(chain: string, escrowAddress: string, tokenAddress: string): boolean {
  if (chain !== "sepolia") return false;
  const approvedEscrows = parseApprovedList(process.env.APPROVED_SEPOLIA_USDC_ESCROWS, DEFAULT_APPROVED_SEPOLIA_USDC_ESCROWS);
  if (!approvedEscrows.has(escrowAddress.toLowerCase())) return false;

  const binding = getUsdcBinding("sepolia");
  if (!binding) return false;
  return binding.tokenAddress.toLowerCase() === tokenAddress.toLowerCase();
}

/** Same idea as isApprovedSettlementContract, for the separate Solana escrow-program address (see solana-settle.ts's submitAttestedSettle) — the account that actually moves funds, not the decision-relay notification program. */
export function isApprovedSolanaEscrowProgram(address: string): boolean {
  const approved = process.env.APPROVED_SOLANA_ESCROW_PROGRAMS?.trim()
    ? process.env.APPROVED_SOLANA_ESCROW_PROGRAMS.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_APPROVED_SOLANA_ESCROW_PROGRAMS;
  return approved.includes(address);
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
// Exported for lib/startup-checks.ts — the worker startup check needs
// to count how many attestor keys THIS process holds (must be strictly
// fewer than the deployed threshold — see runWorkerStartupCheck) and
// confirm each one is a registered attestor, without duplicating
// ATTESTOR_PRIVATE_KEYS/ATTESTOR_PRIVATE_KEY parsing a second time.
export function getAttestorAccounts() {
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

/**
 * Formats CaseSettlement.escrowId (Escrow.sol's own caller-chosen
 * identifier, NOT a hash — see Escrow.sol's `deposit()` doc comment)
 * as a bytes32. Deliberately separate from hashToBytes32 above: that
 * one validates specifically as a 64-hex-char sha256 digest shape,
 * which would reject a shorter numeric/random escrowId with a
 * misleading "must be a sha256 hex digest" error.
 */
function escrowIdToBytes32(escrowId: string, label: string): Hex {
  if (isHex(escrowId)) {
    const hex = escrowId.length % 2 === 0 ? escrowId : (`0x0${escrowId.slice(2)}` as Hex);
    if (hex.length > 66) {
      throw new Error(`${label} is longer than 32 bytes: ${escrowId}`);
    }
    return pad(hex, { size: 32 });
  }
  throw new Error(`${label} must be a 0x-prefixed hex string, got: ${escrowId}`);
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
  const client = getEvmPublicClient();
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
export async function dispatchDecisionForCase(
  params: DispatchDecisionParams
): Promise<{ txHash: string; messageId: string; notificationTxHash?: string }> {
  // Real gate, checked before any chain interaction: see
  // lib/settlement-kyc.ts's own header comment. No-ops unless an
  // operator has actually opted this case's SettlementIntegration into
  // requireKycApproval — additive, not a new universal requirement.
  const { assertKycRequirementMet } = await import("@/lib/settlement-kyc");
  await assertKycRequirementMet(params.caseId);

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

    // Real fix for this session's core P0 finding: escrowId used to
    // always be a hardcoded zero placeholder, because no contract
    // existed to bind it to (see chains/evm/contracts/Escrow.sol —
    // deployed to Sepolia this session). If this case has a real
    // CaseSettlement, its escrowId is used instead, and — the actual
    // fix, not just picking a different placeholder — the real deposit
    // is read from chain and required to exactly match claimant,
    // respondent, and total amount before dispatch is allowed to
    // proceed at all. A case with no CaseSettlement (the common case
    // today, since nothing yet creates one automatically) keeps the
    // old zero-placeholder behavior — this is additive, not a new
    // requirement for every settlement path.
    const caseSettlement = await prisma.caseSettlement.findUnique({
      where: { caseId: params.caseId },
      include: { integration: true },
    });
    // Real fix here (audit finding, live risk once settlementTarget was
    // actually wired via governance this session): a case with no
    // CaseSettlement used to fall back to a hardcoded zero escrowId and
    // dispatch anyway. While DecisionRelay had no settlementTarget
    // configured, that was harmless (handle() never called settle() at
    // all — see the twelfth/thirteenth addenda). Now that a real target
    // IS configured, the exact same zero-escrowId dispatch would reach
    // Escrow.settle() for real, either reverting (UnknownEscrow, the
    // common case) or — if any future deposit ever legitimately used
    // escrowId 0x0 — settling against the wrong case's funds. A
    // real-money settlement must require a real, on-chain-verified
    // CaseSettlement; there is no safe fallback anymore.
    if (!caseSettlement) {
      throw new Error(
        `case ${params.caseId} has no CaseSettlement — refusing to dispatch a real settlement with no verified on-chain escrow to bind it to`
      );
    }
    // Real fix for the re-audit's Phase 1 finding: the app used to
    // verify a deposit against CaseSettlement.integration without ever
    // checking those two other real facts — that the integration is
    // still active, and that the case's own record of deposit status
    // actually says DEPOSITED (not PENDING_DEPOSIT, already SETTLED
    // elsewhere, or already MISMATCH_BLOCKED). Checked before any chain
    // read, since these are cheap DB-level facts.
    if (!caseSettlement.integration.active) {
      throw new Error(`SettlementIntegration ${caseSettlement.integration.id} is not active — refusing to dispatch against a retired/disabled integration`);
    }
    if (caseSettlement.status !== "DEPOSITED") {
      throw new Error(`CaseSettlement ${caseSettlement.id} status is ${caseSettlement.status}, not DEPOSITED — refusing to dispatch`);
    }
    const { assertEscrowDepositMatches, assertSettlementTargetMatchesIntegration, TargetBindingError } = await import("@/lib/escrow");
    // The other real fix from the re-audit: prove the live
    // DecisionRelay actually points at the SAME escrow the app is
    // about to verify a deposit in — these were never compared before.
    // A mismatch here is recorded as MISMATCH_BLOCKED (the schema
    // already modeled this status, previously unused) rather than a
    // bare thrown error the caller has to remember to persist.
    try {
      await assertSettlementTargetMatchesIntegration({
        decisionRelayAddress: params.settlementContract as Address,
        originDomain: HYPERLANE_DOMAIN.sepolia,
        expectedEscrowContractAddress: caseSettlement.integration.escrowContractAddress as Address,
      });
    } catch (err) {
      if (err instanceof TargetBindingError) {
        await prisma.caseSettlement.update({ where: { id: caseSettlement.id }, data: { status: "MISMATCH_BLOCKED" } });
      }
      throw err;
    }
    const escrowId = escrowIdToBytes32(caseSettlement.escrowId, "CaseSettlement.escrowId");
    const { EscrowVersionMismatchError } = await import("@/lib/escrow-version");
    // settlement/route.ts's bind-time check (integration.chain must
    // equal kase.settlementChain) makes this structurally unreachable
    // for a case actually dispatching via this sepolia branch — narrowed
    // explicitly rather than cast, so a future bind-time regression
    // fails loudly here instead of silently using an EVM ABI against a
    // Solana integration.
    if (caseSettlement.integration.escrowVersion === "SOLANA_V1") {
      throw new Error(`case ${params.caseId} is dispatching via sepolia but its bound CaseSettlement integration is SOLANA_V1 — inconsistent record`);
    }
    try {
      await assertEscrowDepositMatches({
        escrowContractAddress: caseSettlement.integration.escrowContractAddress as Address,
        escrowIdBytes32: escrowId,
        expectedClaimant: caseSettlement.claimantAddress as Address,
        expectedRespondent: caseSettlement.respondentAddress as Address,
        expectedTotalAmountWei: params.claimantAmountAtto + params.respondentAmountAtto,
        integrationId: caseSettlement.integrationId,
        escrowVersion: caseSettlement.integration.escrowVersion,
      });
    } catch (err) {
      if (err instanceof EscrowVersionMismatchError) {
        await prisma.caseSettlement.update({ where: { id: caseSettlement.id }, data: { status: "MISMATCH_BLOCKED" } });
      }
      throw err;
    }
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

    // Real deposit-confirmation gate, mirroring the sepolia branch's
    // assertSettlementTargetMatchesIntegration/assertEscrowDepositMatches
    // above — added 2026-09-06, closing a real gap: this branch used to
    // dispatch straight off the Case row's own settlementSolana* fields
    // with no on-chain deposit check at all, unlike the EVM path.
    // Only enforced when a CaseSettlement is actually bound (a case
    // that never registered one keeps its prior, pre-tracking
    // behavior — dispatch straight from Case fields — so this is
    // additive, not a breaking change for existing Solana cases).
    const caseSettlement = await prisma.caseSettlement.findUnique({ where: { caseId: params.caseId }, include: { integration: true } });
    if (caseSettlement && caseSettlement.integration.chain === "solanatestnet") {
      if (caseSettlement.status !== "DEPOSITED") {
        throw new Error(
          `case ${params.caseId} has a bound Solana settlement integration but its CaseSettlement status is ${caseSettlement.status}, not DEPOSITED — refusing to dispatch a settlement with no confirmed deposit`
        );
      }
      if (!caseSettlement.claimantAddress || !caseSettlement.respondentAddress) {
        throw new Error(`case ${params.caseId}'s CaseSettlement is DEPOSITED but missing claimantAddress/respondentAddress — inconsistent record, refusing to dispatch`);
      }
      const { assertSolanaEscrowDepositMatches } = await import("@/lib/solana-escrow");
      await assertSolanaEscrowDepositMatches({
        escrowProgramId: caseSettlement.integration.escrowContractAddress,
        onChainCaseId: caseSettlement.escrowId,
        expectedClaimant: caseSettlement.claimantAddress,
        expectedRespondent: caseSettlement.respondentAddress,
        expectedAmountLamports: BigInt(caseSettlement.expectedAmountAtto),
      });
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

    // Fires the real Hyperlane notification automatically, right after the
    // real settlement above — previously this only ever happened when a
    // human ran a test script by hand (see chains/solana/tests/run-multisig-ism-delivery-proof.ts).
    // Best-effort and non-blocking: attested_settle above is what actually
    // moved funds and has already succeeded by this point, so a dispatch
    // failure here must not surface as a settlement failure — it would
    // only cost this case its explorer-visible notification record, not
    // any money. See docs/mainnet-readiness-runbook.md's Solana ISM
    // migration note for why this notification carries no settlement
    // authority (decision-relay's handle() stays notification-only).
    // Three genuinely distinct identifiers for a Solana settlement — never
    // collapse these into each other:
    //   1. signature       — the real Solana attested_settle transaction
    //                        that actually moved funds (this is what
    //                        relayTxHash means for every other chain too).
    //   2. notificationTxHash — the Sepolia tx hash of the separate
    //                        Mailbox.dispatch() call for the Hyperlane
    //                        notification (a completely different chain
    //                        and a completely different transaction).
    //   3. hyperlaneMessageId — the real message ID Hyperlane itself
    //                        assigns to that dispatch (from the Dispatch
    //                        event), NOT any transaction hash at all —
    //                        this is what Hyperlane's own explorer keys
    //                        on. A prior version of this function
    //                        returned `signature` for both txHash AND
    //                        messageId, which was simply wrong: it meant
    //                        relayMessageId in the database was never a
    //                        real Hyperlane message ID for any Solana
    //                        settlement.
    let notificationTxHash: string | undefined;
    let hyperlaneMessageId: string | undefined;
    const hyperlaneRelayPrivateKey = process.env.HYPERLANE_RELAY_PRIVATE_KEY;
    if (hyperlaneRelayPrivateKey) {
      try {
        const privateKey = (hyperlaneRelayPrivateKey.startsWith("0x") ? hyperlaneRelayPrivateKey : `0x${hyperlaneRelayPrivateKey}`) as `0x${string}`;
        const dispatchResult = await dispatchDecisionRelayToSealevel(
          { originChain: "sepolia", privateKey },
          HYPERLANE_DOMAIN.solanaTestnet,
          params.settlementContract,
          {
            caseId: params.settlementSolanaCaseId,
            claimant: params.settlementSolanaClaimant,
            respondent: params.settlementSolanaRespondent,
            escrowProgram: params.settlementSolanaEscrowProgram,
            claimantShareBps: params.claimantShareBps,
            respondentShareBps: params.respondentShareBps,
            decisionHash: hashToBytes32(params.decisionHash, "decisionHash"),
          }
        );
        notificationTxHash = dispatchResult.txHash;
        hyperlaneMessageId = dispatchResult.messageId;
        console.log(
          `solana settlement notification dispatched via Hyperlane for case ${params.caseId}: ` +
            `sepolia tx ${notificationTxHash}, hyperlane messageId ${hyperlaneMessageId}`
        );
      } catch (err) {
        console.error(
          `solana settlement for case ${params.caseId} succeeded (tx ${signature}) but the Hyperlane notification dispatch failed — funds moved correctly, this only affects explorer visibility:`,
          err
        );
      }
    } else {
      console.warn(`HYPERLANE_RELAY_PRIVATE_KEY not set — skipping Hyperlane notification dispatch for case ${params.caseId} (settlement itself still succeeded)`);
    }

    // messageId falls back to the settle signature only when the
    // notification never went out at all (no relay key configured, or
    // the dispatch itself failed) — better than null for callers that
    // treat messageId as required, but never confused with a real
    // Hyperlane message ID: notificationTxHash being undefined is the
    // signal that this fallback happened.
    return { txHash: signature, messageId: hyperlaneMessageId ?? signature, notificationTxHash };
  }

  throw new Error(
    `unsupported settlementChain "${params.settlementChain}" — supported: sepolia, solanatestnet (see packages/hyperlane-relay)`
  );
}
