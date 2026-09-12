import { describe, it, expect } from "vitest";
import { toAtomicAmount } from "@/lib/money";
import { toAttoAmount } from "@/lib/genlayer";

describe("toAtomicAmount — decimal-aware atomic-unit conversion", () => {
  it("computes the correct atomic amount for a non-18-decimals asset (e.g. Solana's 9-decimal lamports), not an 18-decimal ETH one", () => {
    const solAmount = toAtomicAmount("50", 9);
    expect(solAmount).toBe(50_000_000_000n);
    expect(solAmount).not.toBe(toAttoAmount("50"));
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
