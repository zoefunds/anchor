// Phase F.1 of the 2026-09-12 incident recovery brief — independently,
// cryptographically verifies that at least `threshold` validators have
// published a VALID signed checkpoint covering a given leaf index,
// fetching checkpoints anonymously exactly as the relayer does (no
// credentials, no manual pointer edits). This never trusts
// checkpoint_latest_index.json — it probes real checkpoint files
// directly, so a stale/wrong pointer (see the incident doc's caution
// about that) can't produce a false "healthy" result here.
//
// Usage: npx tsx scripts/verify-checkpoint-quorum.ts <leafIndex>
import { recoverAddress, keccak256, encodePacked, type Hex } from "viem";
import { ACTIVE_SEPOLIA_TOPOLOGY } from "../src/lib/deployment-registry";

const VALIDATORS = [
  { address: "0x2ffFd80d446835214EF87Eb3753B48935550f73f", label: "validator1", bucket: "anchor-hyperlane-validator-checkpoints", prefix: "validator1" },
  { address: "0xf171c23607b892797Eb5eb4e52fc668f924Df0A3", label: "validator2", bucket: "anchor-hyperlane-validator-checkpoints", prefix: "validator2" },
  { address: "0x4dbc8704ebD282535d64Be6daDF2a477C543114D", label: "validator3", bucket: "anchor-hyperlane-validator3-checkpoints", prefix: "validator3" },
] as const;

const THRESHOLD = ACTIVE_SEPOLIA_TOPOLOGY.attestorThreshold;

interface CheckpointFile {
  value: {
    checkpoint: { merkle_tree_hook_address: string; mailbox_domain: number; root: Hex; index: number };
    message_id: Hex;
  };
  signature: { r: Hex; s: Hex; v: number };
  serialized_signature: Hex;
}

// Real Hyperlane CheckpointLib.sol formula (confirmed against upstream
// source, not guessed):
//   domainHash = keccak256(abi.encodePacked(origin, merkleTreeHook, "HYPERLANE"))
//   digest = toEthSignedMessageHash(keccak256(abi.encodePacked(domainHash, root, index, messageId)))
// An earlier version of this script guessed a formula omitting
// domainHash's "HYPERLANE" salt and the messageId field entirely, which
// produced signatures that recovered to unrelated addresses — a false
// "quorum not reachable" result. Corrected against upstream before
// trusting this script's output.
function domainHash(origin: number, merkleTreeHookBytes32: Hex): Hex {
  return keccak256(encodePacked(["uint32", "bytes32", "string"], [origin, merkleTreeHookBytes32, "HYPERLANE"]));
}
function checkpointDigest(origin: number, merkleTreeHook: Hex, root: Hex, index: number, messageId: Hex): Hex {
  const dHash = domainHash(origin, merkleTreeHook);
  const inner = keccak256(encodePacked(["bytes32", "bytes32", "uint32", "bytes32"], [dHash, root, index, messageId]));
  const prefixed = encodePacked(["string", "bytes32"], ["\x19Ethereum Signed Message:\n32", inner]);
  return keccak256(prefixed);
}

async function fetchCheckpoint(bucket: string, prefix: string, index: number): Promise<CheckpointFile | null> {
  const url = `https://${bucket}.s3.eu-north-1.amazonaws.com/${prefix}/checkpoint_${index}_with_id.json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return (await res.json()) as CheckpointFile;
}

async function main() {
  const leafIndex = Number(process.argv[2]);
  if (!Number.isFinite(leafIndex)) throw new Error("usage: verify-checkpoint-quorum.ts <leafIndex>");

  console.log(`Verifying checkpoint quorum for leaf index ${leafIndex} (threshold ${THRESHOLD}-of-${VALIDATORS.length})`);
  let validCount = 0;
  const results: string[] = [];

  for (const v of VALIDATORS) {
    // A validator's checkpoint at exactly `leafIndex` proves inclusion
    // of that leaf; a checkpoint at a HIGHER index also proves it
    // (later checkpoints supersede earlier roots for the same tree), so
    // probe forward from leafIndex to find the nearest available one.
    let found: CheckpointFile | null = null;
    let probedIndex = leafIndex;
    for (let i = 0; i < 20 && !found; i++, probedIndex++) {
      found = await fetchCheckpoint(v.bucket, v.prefix, probedIndex);
    }
    if (!found) {
      results.push(`${v.label}: NO CHECKPOINT FOUND covering leaf ${leafIndex} (probed ${leafIndex}..${probedIndex - 1})`);
      continue;
    }
    const { root, index, mailbox_domain, merkle_tree_hook_address } = found.value.checkpoint;
    const expectedHookBytes32 = `0x${"0".repeat(24)}${ACTIVE_SEPOLIA_TOPOLOGY.merkleTreeHook.slice(2).toLowerCase()}`;
    if (merkle_tree_hook_address.toLowerCase() !== expectedHookBytes32) {
      results.push(`${v.label}: checkpoint's merkle_tree_hook_address (${merkle_tree_hook_address}) does NOT match active hook (${ACTIVE_SEPOLIA_TOPOLOGY.merkleTreeHook}) — REJECTED`);
      continue;
    }
    const digest = checkpointDigest(mailbox_domain, merkle_tree_hook_address as Hex, root, index, found.value.message_id);
    const recovered = await recoverAddress({ hash: digest, signature: found.serialized_signature });
    const valid = recovered.toLowerCase() === v.address.toLowerCase();
    if (valid) validCount++;
    results.push(
      `${v.label}: checkpoint index=${index} root=${root} — signature recovers to ${recovered} (expected ${v.address}) — ${valid ? "VALID" : "INVALID — SIGNATURE DOES NOT MATCH THIS VALIDATOR"}`
    );
  }

  console.log(results.join("\n"));
  console.log(`\nUsable valid signatures: ${validCount}/${VALIDATORS.length} (threshold ${THRESHOLD})`);
  console.log(validCount >= THRESHOLD ? "QUORUM REACHABLE from independently-fetched, cryptographically-verified checkpoints." : "QUORUM NOT REACHABLE — this leaf cannot be relayed until this changes.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
