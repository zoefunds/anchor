import { describe, it, expect } from "vitest";
import { assertEnvironmentSafeToBoot, StartupCheckError } from "@/lib/startup-checks";
import { ANCHOR_ENVIRONMENTS, isApprovedForEnvironment } from "@/lib/environment-registry";

// Phase 6's single most important correctness property: a non-testnet
// (mainnet-flagged) environment configured with settlementPaused: false
// must throw at startup-check time, not warn. Verified here with real
// revert-and-confirm discipline — mutate a clone of the live registry
// entry to the unsafe state, confirm the throw, then confirm the
// checked-in default (settlementPaused: true) passes.

describe("assertEnvironmentSafeToBoot", () => {
  it("passes for every currently-defined testnet environment regardless of settlementPaused", () => {
    expect(() => assertEnvironmentSafeToBoot("studio-next-testnet")).not.toThrow();
    expect(() => assertEnvironmentSafeToBoot("sepolia")).not.toThrow();
    expect(() => assertEnvironmentSafeToBoot("solana-testnet")).not.toThrow();
  });

  it("passes for the checked-in mainnet placeholders because they default to settlementPaused: true", () => {
    expect(() => assertEnvironmentSafeToBoot("genlayer-mainnet")).not.toThrow();
    expect(() => assertEnvironmentSafeToBoot("ethereum-mainnet")).not.toThrow();
    expect(() => assertEnvironmentSafeToBoot("solana-mainnet")).not.toThrow();
  });

  it("throws for a mainnet environment if settlementPaused were ever flipped to false (revert-and-confirm)", () => {
    const original = ANCHOR_ENVIRONMENTS["ethereum-mainnet"].settlementPaused;
    expect(original).toBe(true);

    // Simulate the unsafe state directly against the live registry object
    // (mutate, assert throw, then revert) rather than a disconnected copy —
    // this proves assertEnvironmentSafeToBoot reads live registry state,
    // not a snapshot that could silently diverge from what it checks.
    ANCHOR_ENVIRONMENTS["ethereum-mainnet"].settlementPaused = false;
    try {
      expect(() => assertEnvironmentSafeToBoot("ethereum-mainnet")).toThrow(StartupCheckError);
    } finally {
      ANCHOR_ENVIRONMENTS["ethereum-mainnet"].settlementPaused = original;
    }

    // Confirm: reverted state passes again.
    expect(() => assertEnvironmentSafeToBoot("ethereum-mainnet")).not.toThrow();
  });

  it("throws for an unknown environment id", () => {
    expect(() => assertEnvironmentSafeToBoot("not-a-real-environment" as never)).toThrow(StartupCheckError);
  });
});

describe("isApprovedForEnvironment", () => {
  it("does not treat a sepolia-approved address as approved on ethereum-mainnet", () => {
    const sepoliaAddr = ANCHOR_ENVIRONMENTS.sepolia.addresses.decisionRelay!;
    expect(isApprovedForEnvironment("sepolia", sepoliaAddr)).toBe(true);
    expect(isApprovedForEnvironment("ethereum-mainnet", sepoliaAddr)).toBe(false);
  });

  it("does not treat a solana-testnet escrow program as approved on solana-mainnet", () => {
    const testnetProgram = ANCHOR_ENVIRONMENTS["solana-testnet"].addresses.escrowProgram!;
    expect(isApprovedForEnvironment("solana-testnet", testnetProgram)).toBe(true);
    expect(isApprovedForEnvironment("solana-mainnet", testnetProgram)).toBe(false);
  });
});
