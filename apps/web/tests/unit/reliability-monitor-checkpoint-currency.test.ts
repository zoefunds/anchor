import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ACTIVE_VALIDATORS } from "@/lib/deployment-registry";

// Regression test for a real, previously-live bug (found 2026-09-06 while
// verifying the validator2-replacement cutover): this module's
// checkCheckpointCurrency compared a validator's latest signed checkpoint
// index against Mailbox.nonce() -- the shared dispatch counter for
// Hyperlane's canonical Sepolia mailbox, used by the entire ecosystem, not
// something this project owns exclusively. This is the exact same bug
// already found and fixed in
// chains/hyperlane-validator/scripts/verify-deployment.ts (see that
// script's own test, verify-deployment-checkpoint-currency.test.ts) --
// but this is a genuinely separate implementation (this module is
// intentionally self-contained, per its own header comment, since
// chains/hyperlane-validator isn't shipped in the worker's Docker image)
// and it carried the same bug independently. On the live production
// dashboard this produced a fake ~1370-leaf "lag" and a false
// DELIVERY_BLOCKED state, confirmed against real on-chain reads showing
// the true lag was 1 leaf.
//
// Also regression-tests that DECISION_RELAY/ISM aren't left pointing at a
// retired contract again -- they were found still set to the
// pre-validator3-cutover addresses when this fix was made, meaning
// decisionrelay:ism/wiring checks on the live dashboard had been silently
// checking the wrong contracts since before validator3 even existed.

const __dirname = dirname(fileURLToPath(import.meta.url));
const moduleSource = readFileSync(join(__dirname, "..", "..", "src", "lib", "reliability-monitor.ts"), "utf-8");

function checkpointCurrencyBody(): string {
  const start = moduleSource.indexOf("async function checkCheckpointCurrency");
  const end = moduleSource.indexOf("/**", start + 1);
  return moduleSource.slice(start, end);
}

describe("reliability-monitor checkCheckpointCurrency regression: must compare against MerkleTreeHook, never Mailbox.nonce", () => {
  it("reads the currency comparator from MerkleTreeHook.count(), not Mailbox.nonce()", () => {
    const body = checkpointCurrencyBody();
    expect(body).toContain("MERKLE_TREE_HOOK");
    expect(body).toContain('functionName: "count"');
  });

  it("never reads Mailbox.nonce() as the currency comparator (the actual historical bug)", () => {
    const body = checkpointCurrencyBody();
    expect(body).not.toContain('functionName: "nonce"');
    expect(moduleSource).not.toContain("MAILBOX_ABI");
  });

  it("DecisionRelay and ISM addresses are the current post-validator2-replacement contracts, not a retired pair", () => {
    // Retired addresses this module was found still pointing at.
    expect(moduleSource).not.toContain("0xdddc52e9D20957Fb3Afe0dbee165857Cd6ADE968");
    expect(moduleSource).not.toContain("0xf9Ceb195C295c496952649574A78B2Da6dD7b05f");
    expect(moduleSource).not.toContain("0x12495e1C55e6257fdE1e1ED0be463477DAFA9907");
    expect(moduleSource).not.toContain("0xf80B4De13f895ae9D3062aD78500F2C45c865109");
  });

  it("reliability-monitor.ts sources its VALIDATORS from the shared deployment registry, not its own literal", () => {
    // Incident recovery Phase B (2026-09-13): every hardcoded topology
    // literal in this file (mailbox, hook, announce, DecisionRelay, ISM,
    // validators) was migrated to import from deployment-registry.ts,
    // so a future contract migration can't leave this file behind again
    // without every consumer of the registry updating together.
    expect(moduleSource).toContain('import { ACTIVE_SEPOLIA_TOPOLOGY, ACTIVE_VALIDATORS } from "@/lib/deployment-registry"');
    expect(moduleSource).toContain("const VALIDATORS = ACTIVE_VALIDATORS;");
  });

  it("the registry's ACTIVE_VALIDATORS includes all 3 live validators, not the stale 2-validator list", () => {
    const addresses = ACTIVE_VALIDATORS.map((v) => v.address);
    expect(addresses).toContain("0x2ffFd80d446835214EF87Eb3753B48935550f73f"); // validator1
    expect(addresses).toContain("0xf171c23607b892797Eb5eb4e52fc668f924Df0A3"); // validator2 (post-replacement)
    expect(addresses).toContain("0x4dbc8704ebD282535d64Be6daDF2a477C543114D"); // validator3
    expect(addresses).not.toContain("0x0eD86FBF8cb56622BB3094FeCde2872018e0f4B3"); // retired validator2
  });
});
