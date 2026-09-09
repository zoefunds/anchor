import { type Address, type Hex, encodeFunctionData } from "viem";
import { getEvmPublicClient } from "@/lib/hyperlane";
import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/audit";
import { verifyEscrowCodeIdentity, verifyEscrowUsdcCodeIdentity, EscrowCodeIdentityError } from "@/lib/escrow-code-identity";

// Priority 2 (settlement-readiness gaps): explicit, verified
// contract-version detection — never an assumption from "which address
// happens to be configured." The real bug this closes (found live,
// this session): case-settlement.ts and reconciliation.ts both
// hardcoded a V1-shaped deposits() ABI everywhere, which happened to
// be correct only because every integration so far has pointed at V1.
// The moment a V2 integration exists, that same hardcoded assumption
// would silently mis-decode again — this module makes the ABI
// selection a real, per-integration, verified fact instead.
//
// Detection method: NOT bytecode hashing. A real attempt at that (see
// this module's own git history / commit message) hit two dead ends —
// an immutable constructor argument (decisionRelay) baked directly
// into the runtime bytecode at different offsets depending on the
// value, and a raw bytecode LENGTH mismatch between the real deployed
// V1 contract and a fresh local build of the identical source, from
// compiler/optimizer settings drift alone. Neither is a reliable
// signal. What IS reliable, and independent of compiler settings: a
// Solidity public-mapping-to-struct getter, called with ANY key
// (deposited or not — every field is fixed-size, so the ABI encoder
// always returns the full tuple width), returns a raw byte length
// that exactly encodes the number of 32-byte fields the struct has.
// V1 (status, claimant, respondent, amount) => 4 * 32 = 128 bytes. V2
// (+ caseId, + depositedAt) => 6 * 32 = 192 bytes. This is measured via
// a raw eth_call — deliberately never ABI-decoded, since decoding is
// exactly the operation whose correctness this function exists to
// establish in the first place.

const DEPOSITS_SELECTOR_ABI = [
  { type: "function", name: "deposits", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [] },
] as const;

const V1_RETURN_BYTES = 128; // status, claimant, respondent, amount
const V2_RETURN_BYTES = 192; // + caseId, + depositedAt

// EscrowUSDC.sol's deposits() returns this SAME 192-byte shape as V2
// (status, claimant, respondent, amount, caseId, depositedAt) — shape
// alone cannot distinguish them. usdcToken() is the real distinguishing
// signal: a public immutable getter EscrowUSDC exposes that native
// Escrow.sol has no equivalent of at all (V1 or V2).
const USDC_TOKEN_GETTER_ABI = [
  { type: "function", name: "usdcToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export class UnknownEscrowVersionError extends Error {}
export class EscrowVersionMismatchError extends Error {}

async function probeUsdcTokenGetter(escrowContractAddress: Address): Promise<Address | null> {
  const client = getEvmPublicClient();
  const data = encodeFunctionData({ abi: USDC_TOKEN_GETTER_ABI, functionName: "usdcToken" });
  try {
    const result = await client.call({ to: escrowContractAddress, data });
    const raw = result.data;
    if (!raw || raw.length !== 66) return null; // 0x + 64 hex chars = one padded address slot
    const address = ("0x" + raw.slice(-40)) as Address;
    if (address === "0x0000000000000000000000000000000000000000") return null;
    return address;
  } catch {
    return null; // no usdcToken() function at all — not an EscrowUSDC contract
  }
}

async function probeDepositsReturnLength(escrowContractAddress: Address): Promise<number> {
  const client = getEvmPublicClient();
  const data = encodeFunctionData({
    abi: DEPOSITS_SELECTOR_ABI,
    functionName: "deposits",
    args: [("0x" + "00".repeat(32)) as Hex],
  });
  try {
    const result = await client.call({ to: escrowContractAddress, data });
    const raw = result.data ?? "0x";
    return (raw.length - 2) / 2;
  } catch {
    // A contract with no deposits() function at all (no fallback)
    // reverts the call outright rather than returning odd-length
    // data — real edge case found writing this suite's own "fails
    // closed on an unrecognized contract" test. Either way — a
    // revert or a wrong-length success — is "not a known shape";
    // both must fail closed identically, so this collapses to
    // length 0, which versionForReturnLength below rejects the same
    // as any other unrecognized length.
    return 0;
  }
}

function versionForReturnLength(byteLength: number): "V1" | "V2" {
  if (byteLength === V1_RETURN_BYTES) return "V1";
  if (byteLength === V2_RETURN_BYTES) return "V2";
  throw new UnknownEscrowVersionError(
    `escrow contract's deposits() returned ${byteLength} raw bytes — matches neither the known V1 shape (${V1_RETURN_BYTES}) nor V2 shape (${V2_RETURN_BYTES}). Refusing to guess an ABI for an unrecognized contract.`
  );
}

export type EscrowContractVersion = "V1" | "V2" | "USDC_V1";

/**
 * Called once, at registration time (POST /api/settlement-integrations)
 * — establishes the real, verified version a new integration is
 * recorded against. Throws UnknownEscrowVersionError (never silently
 * defaults) for anything that doesn't match a known shape.
 *
 * Security-audit fix (finding #4): shape alone (this function's
 * original scope) proves nothing about actual contract behavior — a
 * proxy or hand-crafted contract can trivially return the right-shaped
 * deposits() tuple while doing anything it wants in deposit()/settle().
 * For V2, this now ALSO verifies real code identity against Anchor's
 * own compiled Escrow.sol (see escrow-code-identity.ts) — a contract
 * that passes the shape check but isn't byte-identical (modulo
 * immutables/metadata) real Escrow.sol code is rejected outright, not
 * registered with an assumed-safe ABI. V1 has no such reference (it's
 * legacy/frozen — no new V1 integrations are expected) and is
 * unaffected.
 */
export async function detectEscrowVersion(escrowContractAddress: Address): Promise<EscrowContractVersion> {
  const usdcTokenAddress = await probeUsdcTokenGetter(escrowContractAddress);
  if (usdcTokenAddress !== null) {
    await verifyEscrowUsdcCodeIdentity(escrowContractAddress);
    return "USDC_V1";
  }

  const byteLength = await probeDepositsReturnLength(escrowContractAddress);
  const version = versionForReturnLength(byteLength);
  if (version === "V2") {
    await verifyEscrowCodeIdentity(escrowContractAddress);
  }
  return version;
}

/**
 * Re-verified on every real read that matters (deposit confirmation,
 * dispatch-time validation) — the realistic threat model is a
 * contract redeployed at the same address after registration
 * (SELFDESTRUCT+CREATE2, or the address was actually a proxy), not
 * merely "this never changes so checking once is enough." A mismatch
 * is never silently tolerated: it throws AND persists an audited
 * ESCROW_VERSION_MISMATCH finding, the same fail-closed discipline
 * Phase 1's target-binding invariant established for
 * settlementTarget/integration mismatches.
 *
 * Security-audit fix (finding #4): the shape check alone can't catch a
 * proxy whose implementation was upgraded AFTER registration — the
 * proxy's own deposits() shape doesn't change just because what it
 * delegates to did. For V2, this now re-verifies real code identity on
 * every call too (see escrow-code-identity.ts), which a proxy fails
 * unconditionally regardless of its current implementation, since a
 * proxy's own bytecode is never byte-identical to real Escrow logic.
 */
export async function verifyEscrowVersionUnchanged(params: { integrationId: string; escrowContractAddress: Address; expectedVersion: EscrowContractVersion }): Promise<void> {
  if (params.expectedVersion === "USDC_V1") {
    const usdcTokenAddress = await probeUsdcTokenGetter(params.escrowContractAddress);
    if (usdcTokenAddress === null) {
      await recordVersionMismatch(params.integrationId, params.escrowContractAddress, "no usdcToken() getter found", params.expectedVersion);
      throw new EscrowVersionMismatchError(
        `escrow ${params.escrowContractAddress} no longer exposes usdcToken() — SettlementIntegration ${params.integrationId} was registered as USDC_V1. This usually means the contract at this address was redeployed after registration.`
      );
    }
    try {
      await verifyEscrowUsdcCodeIdentity(params.escrowContractAddress);
    } catch (err) {
      if (err instanceof EscrowCodeIdentityError) {
        await recordVersionMismatch(params.integrationId, params.escrowContractAddress, "USDC_V1 (usdcToken() present, but code identity does not match — possible proxy or malicious replacement)", params.expectedVersion);
      }
      throw err;
    }
    return;
  }

  const byteLength = await probeDepositsReturnLength(params.escrowContractAddress);
  let liveVersion: "V1" | "V2";
  try {
    liveVersion = versionForReturnLength(byteLength);
  } catch (err) {
    await recordVersionMismatch(params.integrationId, params.escrowContractAddress, `unrecognized (${byteLength} raw bytes)`, params.expectedVersion);
    throw err;
  }
  if (liveVersion !== params.expectedVersion) {
    await recordVersionMismatch(params.integrationId, params.escrowContractAddress, liveVersion, params.expectedVersion);
    throw new EscrowVersionMismatchError(
      `escrow ${params.escrowContractAddress} now behaves like ${liveVersion}, but SettlementIntegration ${params.integrationId} was registered as ${params.expectedVersion} — refusing to decode with a possibly-wrong ABI. This usually means the contract at this address was redeployed after registration.`
    );
  }
  if (liveVersion === "V2") {
    try {
      await verifyEscrowCodeIdentity(params.escrowContractAddress);
    } catch (err) {
      if (err instanceof EscrowCodeIdentityError) {
        await recordVersionMismatch(params.integrationId, params.escrowContractAddress, "V2 (shape matches, but code identity does not — possible proxy or malicious replacement)", params.expectedVersion);
      }
      throw err;
    }
  }
}

async function recordVersionMismatch(integrationId: string, escrowContractAddress: Address, liveVersion: string, expectedVersion: string): Promise<void> {
  const integration = await prisma.settlementIntegration.findUnique({ where: { id: integrationId } });
  if (!integration) return;

  const existing = await prisma.reconciliationFinding.findUnique({
    where: { type_targetId: { type: "ESCROW_VERSION_MISMATCH", targetId: integrationId } },
  });
  // Real fix: this used to unconditionally reset alertedAt to null on
  // every single call, which — since verifyEscrowVersionUnchanged runs
  // on every real deposit-confirmation/dispatch read — would have
  // fired a fresh Slack alert every time, not once per opened finding.
  // Worse, it never actually delivered an alert at all (no call to
  // sendOpsAlert/tryAlert existed here) — this closes both gaps at
  // once, matching raiseFinding's own discipline in reconciliation.ts:
  // alert once when newly opened, retry only if never actually
  // delivered, never re-alert a still-open, already-alerted finding.
  const alreadyOpenAndAlerted = existing && !existing.resolvedAt && existing.alertedAt;
  if (alreadyOpenAndAlerted) return;

  const finding = await prisma.$transaction(async (tx) => {
    const upserted = await tx.reconciliationFinding.upsert({
      where: { type_targetId: { type: "ESCROW_VERSION_MISMATCH", targetId: integrationId } },
      create: {
        type: "ESCROW_VERSION_MISMATCH",
        targetType: "SettlementIntegration",
        targetId: integrationId,
        detail: { escrowContractAddress, expectedVersion, liveVersion },
      },
      update: { resolvedAt: null, detail: { escrowContractAddress, expectedVersion, liveVersion } },
    });
    await logAction(
      {
        organizationId: integration.organizationId,
        action: "settlement_integration.escrow_version_mismatch",
        targetType: "SettlementIntegration",
        targetId: integrationId,
        metadata: { escrowContractAddress, expectedVersion, liveVersion },
      },
      tx
    );
    return upserted;
  });

  const { tryAlert } = await import("@/lib/reconciliation");
  await tryAlert(finding.id, {
    severity: "critical",
    title: "Escrow contract version mismatch",
    detail: `Integration ${integrationId}'s escrow ${escrowContractAddress} now behaves like ${liveVersion}, but was registered as ${expectedVersion}. This usually means the contract was redeployed after registration.`,
  });
}

/** The version-appropriate deposits() ABI — this is the ONE place in the codebase that should ever construct this ABI; every reader (case-settlement.ts, escrow.ts, reconciliation.ts) should call this instead of hardcoding a shape. */
export function depositsAbiForVersion(version: EscrowContractVersion) {
  const base = [
    { name: "status", type: "uint8" },
    { name: "claimant", type: "address" },
    { name: "respondent", type: "address" },
    { name: "amount", type: "uint256" },
  ] as const;
  const v2Extra = [
    { name: "caseId", type: "bytes32" },
    { name: "depositedAt", type: "uint256" },
  ] as const;
  // USDC_V1's Deposit struct is field-for-field identical to V2's
  // (see EscrowUSDC.sol's own Deposit struct) — same ABI, distinct
  // EscrowVersion value only for audit/code-identity clarity.
  return [
    {
      type: "function",
      name: "deposits",
      stateMutability: "view",
      inputs: [{ name: "", type: "bytes32" }],
      outputs: version === "V1" ? base : [...base, ...v2Extra],
    },
  ] as const;
}
