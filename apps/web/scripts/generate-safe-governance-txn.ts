// Prepares (but never sends) the DecisionRelay governance calldata to
// move from "backend key + your manually-held offline attestor key" to
// "backend key + AWS KMS signer + GCP KMS signer" (2-of-3, three
// genuinely automated signers, none of them requiring you personally).
//
// This script only PRINTS calldata for you to paste into Safe{Wallet}'s
// Transaction Builder app (or review before using any other Safe
// signing flow) — it holds no Safe signing key and cannot execute
// anything. Per the standing constraint on this project: no governance
// change (attestor set, threshold, Safe config) happens without your
// explicit review and signature.
//
// Run: npx tsx scripts/generate-safe-governance-txn.ts \
//        --aws-attestor 0x... --gcp-attestor 0x... [--remove-manual-attestor 0x...]
import { encodeFunctionData, isAddress, type Address } from "viem";
import { ACTIVE_SEPOLIA_TOPOLOGY } from "../src/lib/deployment-registry";

const DECISION_RELAY_ABI = [
  { type: "function", name: "addAttestor", stateMutability: "nonpayable", inputs: [{ name: "_attestor", type: "address" }], outputs: [] },
  { type: "function", name: "removeAttestor", stateMutability: "nonpayable", inputs: [{ name: "_attestor", type: "address" }], outputs: [] },
  { type: "function", name: "setAttestorThreshold", stateMutability: "nonpayable", inputs: [{ name: "_threshold", type: "uint256" }], outputs: [] },
] as const;

// Real gap found and fixed 2026-09-13 (incident recovery Phase 1): this
// hardcoded the retired 0x1fc130416... DecisionRelay — a governance
// transaction generated against the WRONG contract is exactly the kind
// of silent mistake this script's own "never sends, only prints for
// review" design is meant to guard against, but a stale target address
// defeats that review entirely if the reviewer trusts the script's
// header comment instead of re-checking. Sourced from the same single
// registry every other consumer reads from.
const DECISION_RELAY: Address = ACTIVE_SEPOLIA_TOPOLOGY.decisionRelay;

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function main() {
  const awsAttestor = arg("aws-attestor");
  const gcpAttestor = arg("gcp-attestor");
  const removeManualAttestor = arg("remove-manual-attestor");

  if (!awsAttestor || !isAddress(awsAttestor, { strict: false })) throw new Error("--aws-attestor <address> is required and must be a valid address");
  if (!gcpAttestor || !isAddress(gcpAttestor, { strict: false })) throw new Error("--gcp-attestor <address> is required and must be a valid address");
  if (removeManualAttestor && !isAddress(removeManualAttestor, { strict: false })) throw new Error("--remove-manual-attestor must be a valid address if provided");

  const calls: { to: Address; data: `0x${string}`; description: string }[] = [
    {
      to: DECISION_RELAY,
      data: encodeFunctionData({ abi: DECISION_RELAY_ABI, functionName: "addAttestor", args: [awsAttestor] }),
      description: `addAttestor(${awsAttestor}) — the new AWS KMS-backed automated signer`,
    },
    {
      to: DECISION_RELAY,
      data: encodeFunctionData({ abi: DECISION_RELAY_ABI, functionName: "addAttestor", args: [gcpAttestor] }),
      description: `addAttestor(${gcpAttestor}) — the new GCP KMS-backed automated signer`,
    },
  ];

  if (removeManualAttestor) {
    calls.push({
      to: DECISION_RELAY,
      data: encodeFunctionData({ abi: DECISION_RELAY_ABI, functionName: "removeAttestor", args: [removeManualAttestor as Address] }),
      description: `removeAttestor(${removeManualAttestor}) — retires the manually-held offline attestor key; requires the two addAttestor calls above to execute FIRST (contract enforces attestorCount - 1 >= attestorThreshold)`,
    });
  }

  console.log("Paste these into Safe{Wallet}'s Transaction Builder, IN THIS ORDER, as a single batch:\n");
  for (const call of calls) {
    console.log(`--- ${call.description} ---`);
    console.log(`to:   ${call.to}`);
    console.log(`data: ${call.data}`);
    console.log(`value: 0\n`);
  }

  console.log(
    "attestorThreshold does NOT need to change — it is already 2, and after " +
      "these calls there will be 3 attestors (backend key + AWS + GCP), " +
      "making this a real 2-of-3. Do not call setAttestorThreshold as part " +
      "of this batch unless you have independently decided to change it.\n" +
      "Before signing: re-run `npx tsx scripts/generate-deployment-manifest.ts` " +
      "to confirm DECISION_RELAY's owner/threshold/attestor set still match " +
      "what this script assumed, and confirm the two new addresses really " +
      "are the KMS keys' derived addresses (from createAwsKmsSigner/" +
      "createGcpKmsSigner's own logged `address`), not typed from memory."
  );
}

main();
