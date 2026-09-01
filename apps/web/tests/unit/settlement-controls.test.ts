import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isSettlementPaused, getSettlementLimitAtto } from "@/lib/adjudication-service";

const ENV_KEYS = [
  "SETTLEMENT_PAUSED",
  "SETTLEMENT_LIMIT_ATTO_DEFAULT",
  "SETTLEMENT_LIMIT_ATTO_SEPOLIA",
  "SETTLEMENT_LIMIT_ATTO_SOLANA_TESTNET",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("isSettlementPaused", () => {
  it("is false when SETTLEMENT_PAUSED is unset", () => {
    expect(isSettlementPaused()).toBe(false);
  });

  it("is true only when SETTLEMENT_PAUSED is exactly \"true\"", () => {
    process.env.SETTLEMENT_PAUSED = "true";
    expect(isSettlementPaused()).toBe(true);
  });

  it("is false for any other value, including truthy-looking strings", () => {
    process.env.SETTLEMENT_PAUSED = "1";
    expect(isSettlementPaused()).toBe(false);
    process.env.SETTLEMENT_PAUSED = "TRUE";
    expect(isSettlementPaused()).toBe(false);
    process.env.SETTLEMENT_PAUSED = "yes";
    expect(isSettlementPaused()).toBe(false);
  });
});

describe("getSettlementLimitAtto", () => {
  it("returns null (no limit enforced) when nothing is configured", () => {
    expect(getSettlementLimitAtto("sepolia")).toBeNull();
  });

  it("uses the chain-specific var when set", () => {
    process.env.SETTLEMENT_LIMIT_ATTO_SEPOLIA = "1000000000000000000";
    expect(getSettlementLimitAtto("sepolia")).toBe(1000000000000000000n);
  });

  it("is case-insensitive and normalizes non-alphanumeric chain names", () => {
    process.env.SETTLEMENT_LIMIT_ATTO_SOLANA_TESTNET = "500";
    expect(getSettlementLimitAtto("solana:testnet")).toBe(500n);
    expect(getSettlementLimitAtto("Solana-Testnet")).toBe(500n);
  });

  it("falls back to the default var when no chain-specific var is set", () => {
    process.env.SETTLEMENT_LIMIT_ATTO_DEFAULT = "42";
    expect(getSettlementLimitAtto("base")).toBe(42n);
  });

  it("prefers the chain-specific var over the default", () => {
    process.env.SETTLEMENT_LIMIT_ATTO_DEFAULT = "42";
    process.env.SETTLEMENT_LIMIT_ATTO_SEPOLIA = "99";
    expect(getSettlementLimitAtto("sepolia")).toBe(99n);
  });

  it("fails closed (0n) on a negative configured limit rather than treating it as unlimited", () => {
    process.env.SETTLEMENT_LIMIT_ATTO_DEFAULT = "-1";
    expect(getSettlementLimitAtto("sepolia")).toBe(0n);
  });

  it("fails closed (0n) on an unparseable configured limit rather than treating it as unlimited", () => {
    process.env.SETTLEMENT_LIMIT_ATTO_DEFAULT = "not-a-number";
    expect(getSettlementLimitAtto("sepolia")).toBe(0n);
  });
});
