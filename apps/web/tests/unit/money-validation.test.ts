import { describe, it, expect } from "vitest";
import { parseCanonicalDecimalAmount, InvalidAmountError } from "@/lib/money";

// Real regression coverage for the Number()-based amount validation fix
// (external audit finding) — see lib/money.ts's own header comment for
// the precision-loss bug this replaces.
describe("parseCanonicalDecimalAmount", () => {
  it("accepts a plain integer decimal string", () => {
    expect(parseCanonicalDecimalAmount("100")).toBe("100");
  });

  it("accepts a fractional decimal string", () => {
    expect(parseCanonicalDecimalAmount("1250.50")).toBe("1250.50");
  });

  it("accepts exactly 30 fractional digits (the DB column's own precision)", () => {
    const value = "1." + "1".repeat(30);
    expect(parseCanonicalDecimalAmount(value)).toBe(value);
  });

  it("rejects 31 fractional digits", () => {
    const value = "1." + "1".repeat(31);
    expect(() => parseCanonicalDecimalAmount(value)).toThrow(InvalidAmountError);
  });

  it("rejects a JSON numeric literal outright, not coerced", () => {
    expect(() => parseCanonicalDecimalAmount(100)).toThrow(InvalidAmountError);
    expect(() => parseCanonicalDecimalAmount(100.5)).toThrow(InvalidAmountError);
  });

  it("rejects scientific notation", () => {
    expect(() => parseCanonicalDecimalAmount("1e5")).toThrow(InvalidAmountError);
  });

  it("rejects zero and negative amounts", () => {
    expect(() => parseCanonicalDecimalAmount("0")).toThrow(InvalidAmountError);
    expect(() => parseCanonicalDecimalAmount("0.0")).toThrow(InvalidAmountError);
    expect(() => parseCanonicalDecimalAmount("-5")).toThrow(InvalidAmountError);
  });

  it("rejects leading zeros and whitespace", () => {
    expect(() => parseCanonicalDecimalAmount("00123")).toThrow(InvalidAmountError);
    expect(() => parseCanonicalDecimalAmount(" 123")).toThrow(InvalidAmountError);
    expect(() => parseCanonicalDecimalAmount("123 ")).toThrow(InvalidAmountError);
  });

  it("rejects non-numeric garbage", () => {
    expect(() => parseCanonicalDecimalAmount("123abc")).toThrow(InvalidAmountError);
    expect(() => parseCanonicalDecimalAmount(null)).toThrow(InvalidAmountError);
    expect(() => parseCanonicalDecimalAmount(undefined)).toThrow(InvalidAmountError);
  });
});
