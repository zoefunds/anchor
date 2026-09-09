import { type Address } from "viem";
import { getEvmPublicClient } from "@/lib/hyperlane";
import { ESCROW_DEPLOYED_BYTECODE_TEMPLATE, ESCROW_IMMUTABLE_BYTE_RANGES } from "@/lib/escrow-code-reference";
import { ESCROW_USDC_DEPLOYED_BYTECODE_TEMPLATE, ESCROW_USDC_IMMUTABLE_BYTE_RANGES } from "@/lib/escrow-usdc-code-reference";

// Security-audit fix (finding #4, 2026-09-04): escrow-version.ts's own
// detection (deposits() return-length) only proves an address's ABI
// SHAPE matches V1/V2 — a proxy upgraded to malicious logic, or any
// contract crafted to return the right shape while doing something
// else entirely in deposit()/settle()/emergencyRefund(), passes that
// check identically. This module proves actual CODE identity against
// Anchor's own real compiled Escrow.sol, not just its return shape.
//
// Full deployed-bytecode hashing was already tried and abandoned once
// in escrow-version.ts (see that file's own header) because of
// immutable constructor args (decisionRelay, depositAuthorizer,
// emergencyRefundTimeoutSeconds) embedded directly in the runtime
// bytecode at fixed offsets — two real deployments of identical source
// with different constructor args never hash-match. The fix here is
// exactly that gap closed: Foundry's own build artifact
// (deployedBytecode.immutableReferences) records precisely which byte
// ranges those are, so this masks ONLY those ranges (to zero, on both
// sides) before comparing everything else byte-for-byte. What's left
// after masking is Anchor's own real contract logic — a proxy's actual
// bytecode (a delegatecall trampoline, not real settle()/deposit()
// logic) fails this comparison outright, not just a shape check.
//
// Also strips Solidity's trailing CBOR metadata blob (the last
// `2 + metadataLength` bytes, self-describing via its own length
// suffix) — that hash varies with compiler/build-environment metadata
// that has no bearing on actual contract behavior, and would otherwise
// produce false mismatches across two genuinely-identical deployments.

export class EscrowCodeIdentityError extends Error {}

function stripCborMetadata(bytesHex: string): string {
  // bytesHex has no "0x" prefix. The last 2 bytes (4 hex chars) encode
  // the CBOR blob's own length as a big-endian uint16 — a standard,
  // well-documented solc convention, not a guess.
  if (bytesHex.length < 4) return bytesHex;
  const metadataLength = parseInt(bytesHex.slice(-4), 16);
  const totalTrailerHexChars = (metadataLength + 2) * 2;
  if (totalTrailerHexChars <= 0 || totalTrailerHexChars > bytesHex.length) return bytesHex;
  return bytesHex.slice(0, bytesHex.length - totalTrailerHexChars);
}

function maskImmutables(bytesHex: string): string {
  const chars = bytesHex.split("");
  for (const [start, length] of ESCROW_IMMUTABLE_BYTE_RANGES) {
    const startHex = start * 2;
    const endHex = (start + length) * 2;
    for (let i = startHex; i < endHex && i < chars.length; i++) {
      chars[i] = "0";
    }
  }
  return chars.join("");
}

function normalize(rawHex: string): string {
  const withoutPrefix = rawHex.startsWith("0x") ? rawHex.slice(2) : rawHex;
  return maskImmutables(stripCborMetadata(withoutPrefix.toLowerCase()));
}

function normalizeWithRanges(rawHex: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  const withoutPrefix = rawHex.startsWith("0x") ? rawHex.slice(2) : rawHex;
  const stripped = stripCborMetadata(withoutPrefix.toLowerCase());
  const chars = stripped.split("");
  for (const [start, length] of ranges) {
    const startHex = start * 2;
    const endHex = (start + length) * 2;
    for (let i = startHex; i < endHex && i < chars.length; i++) chars[i] = "0";
  }
  return chars.join("");
}

const EXPECTED_NORMALIZED = normalize(ESCROW_DEPLOYED_BYTECODE_TEMPLATE);
const EXPECTED_USDC_NORMALIZED = normalizeWithRanges(ESCROW_USDC_DEPLOYED_BYTECODE_TEMPLATE, ESCROW_USDC_IMMUTABLE_BYTE_RANGES);

/**
 * Real code-identity check — throws EscrowCodeIdentityError (never
 * silently passes) unless the live contract's actual bytecode matches
 * Anchor's own current, real, compiled Escrow.sol exactly (modulo the
 * three known immutable constructor args and compiler metadata).
 * Rejects proxies by construction: a minimal proxy's own bytecode
 * (tens to a few hundred bytes, pure delegatecall) can never match a
 * real Escrow deployment's several-KB of actual logic, regardless of
 * what its delegated-to implementation does or how its deposits()
 * call happens to decode.
 */
export async function verifyEscrowCodeIdentity(escrowContractAddress: Address): Promise<void> {
  const client = getEvmPublicClient();
  const liveCode = await client.getCode({ address: escrowContractAddress });
  if (!liveCode || liveCode === "0x") {
    throw new EscrowCodeIdentityError(`no code at all found at ${escrowContractAddress} — not a deployed contract`);
  }

  const liveNormalized = normalize(liveCode);
  if (liveNormalized !== EXPECTED_NORMALIZED) {
    throw new EscrowCodeIdentityError(
      `${escrowContractAddress}'s deployed bytecode does not match Anchor's own real Escrow.sol (even after masking immutable constructor args and compiler metadata) — this is not a genuine Escrow deployment, or it is a proxy/upgradeable contract, neither of which this system trusts to hold real funds.`
    );
  }
}

/**
 * Same discipline as verifyEscrowCodeIdentity, against EscrowUSDC.sol's
 * own compiled reference instead — needed because EscrowUSDC's
 * deposits() returns the identical 192-byte shape as native V2
 * (status, claimant, respondent, amount, caseId, depositedAt — same 6
 * fields), so the shape probe alone cannot tell them apart. A contract
 * that passes the usdcToken() getter probe (see escrow-version.ts) but
 * isn't byte-identical real EscrowUSDC code is rejected outright.
 */
export async function verifyEscrowUsdcCodeIdentity(escrowContractAddress: Address): Promise<void> {
  const client = getEvmPublicClient();
  const liveCode = await client.getCode({ address: escrowContractAddress });
  if (!liveCode || liveCode === "0x") {
    throw new EscrowCodeIdentityError(`no code at all found at ${escrowContractAddress} — not a deployed contract`);
  }

  const liveNormalized = normalizeWithRanges(liveCode, ESCROW_USDC_IMMUTABLE_BYTE_RANGES);
  if (liveNormalized !== EXPECTED_USDC_NORMALIZED) {
    throw new EscrowCodeIdentityError(
      `${escrowContractAddress}'s deployed bytecode does not match Anchor's own real EscrowUSDC.sol (even after masking immutable constructor args and compiler metadata) — this is not a genuine EscrowUSDC deployment, or it is a proxy/upgradeable contract, neither of which this system trusts to hold real funds.`
    );
  }
}
