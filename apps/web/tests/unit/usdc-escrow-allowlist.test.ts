import { describe, it, expect } from "vitest";

// Track 2, item 1 — "reject arbitrary ERC-20 token addresses" and "only
// this specific registry-bound USDC escrow can ever be a settlement
// target." isApprovedUsdcEscrow (lib/hyperlane.ts) is the one gate meant
// to enforce both halves of that at once: neither an unapproved escrow
// address nor a mismatched token address (even paired with an otherwise
// approved escrow) may pass.

const { isApprovedUsdcEscrow } = await import("@/lib/hyperlane");
const { getUsdcBinding } = await import("@/lib/environment-registry");

const REAL_USDC = getUsdcBinding("sepolia")!.tokenAddress;
const ARBITRARY_ERC20 = "0x000000000000000000000000000000BADC0DE1";
const APPROVED_ESCROW = "0x00000000000000000000000000000000e5c40e";

describe("isApprovedUsdcEscrow", () => {
  it("has a real, non-empty USDC token binding for sepolia", () => {
    expect(REAL_USDC).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("rejects a non-sepolia chain outright", () => {
    expect(isApprovedUsdcEscrow("solanatestnet", APPROVED_ESCROW, REAL_USDC)).toBe(false);
  });

  it("rejects an escrow address that was never approved, even with the real token address", () => {
    expect(isApprovedUsdcEscrow("sepolia", "0x000000000000000000000000000000deadbeef", REAL_USDC)).toBe(false);
  });

  it("rejects an arbitrary ERC-20 token address even if the escrow address were approved", () => {
    const original = process.env.APPROVED_SEPOLIA_USDC_ESCROWS;
    process.env.APPROVED_SEPOLIA_USDC_ESCROWS = APPROVED_ESCROW;
    try {
      expect(isApprovedUsdcEscrow("sepolia", APPROVED_ESCROW, ARBITRARY_ERC20)).toBe(false);
    } finally {
      process.env.APPROVED_SEPOLIA_USDC_ESCROWS = original;
    }
  });

  it("approves only the exact (escrow, token) pair both explicitly bound", () => {
    const original = process.env.APPROVED_SEPOLIA_USDC_ESCROWS;
    process.env.APPROVED_SEPOLIA_USDC_ESCROWS = APPROVED_ESCROW;
    try {
      expect(isApprovedUsdcEscrow("sepolia", APPROVED_ESCROW, REAL_USDC)).toBe(true);
    } finally {
      process.env.APPROVED_SEPOLIA_USDC_ESCROWS = original;
    }
  });

  it("rejects everything when no USDC escrow has been approved yet (the real, current default)", () => {
    expect(isApprovedUsdcEscrow("sepolia", APPROVED_ESCROW, REAL_USDC)).toBe(false);
  });
});
