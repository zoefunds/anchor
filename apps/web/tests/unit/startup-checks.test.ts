import { describe, it, expect } from "vitest";
import {
  assertEvmSignerRegistered,
  assertSolanaSignerRegistered,
  assertWorkerKeyCountBelowThreshold,
  StartupCheckError,
} from "@/lib/startup-checks";
import { loadEvmDeploymentManifest, loadSolanaDeploymentManifest } from "@/lib/deployment-manifest";

// Fills a gap in Phase 1's fail-closed startup checks: nothing exercised
// the actual throw paths against the real committed manifests. An
// unregistered/revoked signer identity reaching production would only
// be caught here — assertEvmSignerRegistered / assertSolanaSignerRegistered
// are meant to abort process boot, not warn-and-continue.

describe("assertEvmSignerRegistered", () => {
  it("throws for a signer address that is not in the manifest's active attestor set", () => {
    expect(() => assertEvmSignerRegistered("0x000000000000000000000000000000baadf00d")).toThrow(StartupCheckError);
  });

  it("does not throw for a currently-registered active attestor", () => {
    const manifest = loadEvmDeploymentManifest();
    if (manifest.flags.length > 0) {
      // Manifest itself is flagged in this checkout — every signer must
      // fail closed, including a genuinely-registered one. Assert that
      // instead so this test still verifies real behavior either way.
      expect(() => assertEvmSignerRegistered(manifest.decisionRelay.attestors.active[0])).toThrow(StartupCheckError);
      return;
    }
    const registered = manifest.decisionRelay.attestors.active[0];
    expect(registered, "fixture assumption: manifest has at least one active attestor").toBeTruthy();
    expect(() => assertEvmSignerRegistered(registered)).not.toThrow();
    // Case-insensitivity: the manifest stores checksum/lowercase addresses,
    // callers may pass either.
    expect(() => assertEvmSignerRegistered(registered.toUpperCase())).not.toThrow();
  });
});

describe("assertSolanaSignerRegistered", () => {
  it("throws for a public key that is not in the manifest's expected attestor set", () => {
    expect(() => assertSolanaSignerRegistered("11111111111111111111111111111111111111111")).toThrow(StartupCheckError);
  });

  it("does not throw for a currently-expected attestor (unless the manifest itself is flagged)", () => {
    const manifest = loadSolanaDeploymentManifest();
    const expected = manifest.decisionRelay.attestors.expected[0];
    expect(expected, "fixture assumption: manifest has at least one expected attestor").toBeTruthy();
    if (manifest.flags.length > 0) {
      expect(() => assertSolanaSignerRegistered(expected)).toThrow(StartupCheckError);
      return;
    }
    expect(() => assertSolanaSignerRegistered(expected)).not.toThrow();
  });
});

describe("assertWorkerKeyCountBelowThreshold", () => {
  it("throws when the worker holds an unregistered EVM key, even below threshold count", () => {
    expect(() =>
      assertWorkerKeyCountBelowThreshold({
        evmSignerAddresses: ["0x000000000000000000000000000000baadf00d"],
        solanaSignerPublicKey: null,
      })
    ).toThrow(StartupCheckError);
  });

  it("throws when the worker's EVM key count alone would meet or exceed the deployed threshold", () => {
    const manifest = loadEvmDeploymentManifest();
    const threshold = Number(manifest.decisionRelay.attestorThreshold);
    const allActive = manifest.decisionRelay.attestors.active;
    expect(allActive.length, "fixture assumption: manifest has enough active attestors to build this case").toBeGreaterThanOrEqual(threshold);
    expect(() =>
      assertWorkerKeyCountBelowThreshold({
        evmSignerAddresses: allActive.slice(0, threshold),
        solanaSignerPublicKey: null,
      })
    ).toThrow(StartupCheckError);
  });
});
