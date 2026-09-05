import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Regression test for a real, previously-live bug: checkCheckpointCurrency
// compared a validator's latest signed checkpoint index against
// Mailbox.nonce() -- the dispatch counter for Hyperlane's shared, canonical
// Sepolia mailbox, used by the entire ecosystem, not something this project
// owns exclusively. Most of that nonce is unrelated third-party traffic
// that never routes through this project's MerkleTreeHook (the Mailbox's
// defaultHook only falls back to it for unmapped destination domains; real
// destinations, including Solana, route to a different hook entirely). The
// only number a validator can ever actually checkpoint up to is
// MerkleTreeHook.count() -- comparing against nonce() produced a
// permanent, unfixable "1370 leaf lag" false alarm that looked exactly
// like a real validator backfill problem. Confirmed live: a freshly-built
// validator3 with zero prior state independently converged on the same
// tree frontier as validators 1 and 2, proving the lag was never
// validator-side.
//
// This test doesn't spin up a real chain -- it inspects the actual source
// so the specific regression (reading the wrong contract/method for this
// comparison) can't silently return, e.g. via a future refactor that
// reintroduces `mailbox.nonce` as the comparator without anyone noticing
// the two numbers are answering different questions.

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptSource = readFileSync(join(__dirname, "verify-deployment.ts"), "utf-8");
const deploymentSchema = JSON.parse(readFileSync(join(__dirname, "..", "deployment.json"), "utf-8"));

describe("checkCheckpointCurrency regression: must compare against MerkleTreeHook, never Mailbox.nonce", () => {
  it("deployment.json declares a merkleTreeHook address", () => {
    expect(deploymentSchema.sepolia.merkleTreeHook).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("the currency-comparator variable is read from merkleTreeHook, not mailbox", () => {
    const fnBody = scriptSource.slice(
      scriptSource.indexOf("async function checkCheckpointCurrency"),
      scriptSource.indexOf("async function checkIsm")
    );
    expect(fnBody).toContain("deployment.sepolia.merkleTreeHook");
    expect(fnBody).toContain('functionName: "count"');
  });

  it("never reads Mailbox.nonce() as the currency comparator (the actual historical bug)", () => {
    const fnBody = scriptSource.slice(
      scriptSource.indexOf("async function checkCheckpointCurrency"),
      scriptSource.indexOf("async function checkIsm")
    );
    expect(fnBody).not.toContain("deployment.sepolia.mailbox,");
    expect(fnBody).not.toContain('functionName: "nonce"');
  });
});
