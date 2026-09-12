import { describe, it, expect } from "vitest";
import { toAtomicAmount } from "@/lib/money";
import { toAttoAmount } from "@/lib/genlayer";

describe("toAtomicAmount — USDC settlement amount correctness", () => {
  it("computes the real 6-decimal USDC atomic amount, not an 18-decimal ETH one", () => {
    // Real incident this closes (2026-09-12): the settlement-binding
    // route and dispatchSettlementForDecision both used to call
    // toAttoAmount (hardcoded 18 decimals) unconditionally, regardless
    // of the bound integration's real assetDecimals. A $50 USDC case
    // would compute an expectedAmountAtto/settlement amount of
    // 50 * 10^18 instead of the real on-chain 50 * 10^6 — the deposit
    // could never be confirmed, and the settle() dispatch would send a
    // catastrophically wrong amount.
    const usdcAmount = toAtomicAmount("50", 6);
    expect(usdcAmount).toBe(50_000_000n);
    expect(usdcAmount).not.toBe(toAttoAmount("50"));
  });

  it("matches toAttoAmount exactly when decimals=18 (native ETH, unchanged behavior)", () => {
    expect(toAtomicAmount("1.5", 18)).toBe(toAttoAmount("1.5"));
  });

  it("rejects more fractional digits than the asset's own decimals allow", () => {
    expect(() => toAtomicAmount("1.1234567", 6)).toThrow(/more than 6 fractional digits/);
  });

  it("rejects a negative amount", () => {
    expect(() => toAtomicAmount("-5", 6)).toThrow(/must not be negative/);
  });
});
