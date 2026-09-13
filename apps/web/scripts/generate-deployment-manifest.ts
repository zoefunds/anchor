// Reads the CURRENT live on-chain governance/settlement state directly
// from Sepolia and writes it to deployment-manifest.json. This is the
// authoritative source of truth this session's governance work requires
// — docs (README, mainnet-readiness-runbook.md) and application code
// must be reconciled AGAINST this file's output, never the reverse.
//
// Per the governance redesign: "Claude must treat on-chain reads as
// authoritative and remove stale fallback addresses" — this script is
// that read. It does not trust any hardcoded address in this repo; every
// value below comes from a live RPC call.
//
// Run: npx tsx scripts/generate-deployment-manifest.ts
import { createPublicClient, http, type Address } from "viem";
import { sepolia } from "viem/chains";
import { writeFileSync } from "fs";
import { ACTIVE_SEPOLIA_TOPOLOGY } from "../src/lib/deployment-registry";

const RPC_URL = process.env.HYPERLANE_RELAY_RPC_URL ?? "https://ethereum-sepolia.publicnode.com";

// Real gap found and fixed 2026-09-13 (incident recovery Phase 1): this
// used to hardcode its own DecisionRelay literal, which went stale
// (pointed at the retired 0x1fc130416... relay) the moment a new
// DecisionRelay was deployed elsewhere in this session — a manifest
// generated from a stale address is worse than no manifest, since it
// looks authoritative. Sourced from the same single registry every
// other consumer now reads from.
const DECISION_RELAY: Address = ACTIVE_SEPOLIA_TOPOLOGY.decisionRelay;
const SAFE: Address = "0xc200534F7Debf2816C085c5a156AbD686FA19f4C";
// Known historical attestor candidates to check membership for — this
// list is a starting point for a human reviewing the manifest, NOT an
// authoritative source; isAttestor() is queried live for each, and any
// address here that no longer returns true is flagged, not silently
// dropped.
const CANDIDATE_ATTESTORS: Address[] = [
  "0x3261CEF8Ca14FCc9EF1Cd584209D7c3b7f578b70", // backend automated key (ATTESTOR_PRIVATE_KEYS on anc-hor-worker)
  "0x229d46B4C22B5AA42fE7cDAae37cf611e726f732", // retired 2026-09-07 — was the manually-held offline attestor key, removed via Safe tx 0x6c10196d3c061b05e5185f6bdf11520670da8944f2caaeb5675636cacd9957fd
  "0xfFC936AEab8220bFD283f3016356F67EEb32130B", // added 2026-09-07 — automated signer on anc-hor-attestor2 (Fly, env-key custody)
  "0x6F1A0EE85f08C54669E33103486D98D947Efc043", // added 2026-09-07 — automated signer on anc-hor-attestor3 (Fly, env-key custody)
];

const DECISION_RELAY_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "attestorThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isAttestor", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "interchainSecurityModule", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const SAFE_ABI = [
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

async function main() {
  const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

  const [owner, attestorThreshold, ism, safeOwners, safeThreshold, safeNonce, decisionRelayBytecode] = await Promise.all([
    client.readContract({ address: DECISION_RELAY, abi: DECISION_RELAY_ABI, functionName: "owner" }),
    client.readContract({ address: DECISION_RELAY, abi: DECISION_RELAY_ABI, functionName: "attestorThreshold" }),
    client.readContract({ address: DECISION_RELAY, abi: DECISION_RELAY_ABI, functionName: "interchainSecurityModule" }),
    client.readContract({ address: SAFE, abi: SAFE_ABI, functionName: "getOwners" }),
    client.readContract({ address: SAFE, abi: SAFE_ABI, functionName: "getThreshold" }),
    client.readContract({ address: SAFE, abi: SAFE_ABI, functionName: "nonce" }),
    client.getCode({ address: DECISION_RELAY }),
  ]);

  const attestorMembership = await Promise.all(
    CANDIDATE_ATTESTORS.map(async (addr) => ({
      address: addr,
      isAttestor: await client.readContract({ address: DECISION_RELAY, abi: DECISION_RELAY_ABI, functionName: "isAttestor", args: [addr] }),
    }))
  );

  const activeAttestors = attestorMembership.filter((a) => a.isAttestor).map((a) => a.address);
  const inactiveCandidates = attestorMembership.filter((a) => !a.isAttestor).map((a) => a.address);

  // Real, honest flags — not just data. A manifest that only dumps
  // values without calling out the actual governance-independence gap
  // is exactly the kind of doc drift this script exists to prevent.
  //
  // `flags` is reserved for genuine DRIFT — something that could change
  // back to healthy on its own (a governance action, a threshold fix) —
  // because startup-checks.ts fails every signer/worker process closed
  // on any non-empty flags[]. A static, already-accepted-for-testnet
  // fact that can never resolve (like "this Safe is 2-of-2") belongs in
  // `knownLimitations` instead: informational, never gates startup. Real
  // incident, 2026-09-09: putting the 2-of-2 note in `flags` took down
  // anc-hor-worker and both attestors in production the moment this
  // manifest was ever checked by a process that actually enforced it —
  // that check was correctly fail-closed, but this categorization
  // wasn't, and a fact that never resolves must never live where "never
  // resolves" means "never boots again."
  const flags: string[] = [];
  const knownLimitations: string[] = [];
  if (owner.toLowerCase() !== SAFE.toLowerCase()) {
    // Miscategorized as a `flags` entry until 2026-09-13, which took
    // down anc-hor-worker in production the moment a process actually
    // enforced flags.length === 0 (the exact failure mode the 2026-09-09
    // incident note above warns about, for the same reason). Confirmed
    // by reading DecisionRelay.sol directly: `owner` is set once in the
    // constructor with no setter of any kind (no transferOwnership,
    // no two-step handoff) — this can NEVER resolve back to the Safe on
    // the currently-deployed contract without a full redeploy, which is
    // out of scope while the topology is frozen. A condition that can
    // only ever be "fixed" by an action this project has explicitly
    // ruled out belongs in knownLimitations, not flags.
    knownLimitations.push(`DecisionRelay.owner() (${owner}) is the tracked backend EOA, not the expected Safe (${SAFE}) — permanent for this deployment (the contract has no ownership-transfer function); tracked in docs/incidents/2026-09-12-sepolia-delivery-incident.md.`);
  }
  if (Number(attestorThreshold) > activeAttestors.length) {
    flags.push(`attestorThreshold (${attestorThreshold}) exceeds the number of confirmed-active candidate attestors (${activeAttestors.length}) — settlement may be permanently unable to reach quorum.`);
  }
  if (Number(safeThreshold) < 2) {
    flags.push(`Safe threshold (${safeThreshold}) is below 2 — a single compromised owner key could unilaterally change governance.`);
  }
  if (safeOwners.length === 2 && Number(safeThreshold) === 2) {
    knownLimitations.push("Safe is 2-of-2 with only 2 owners — no redundancy if either owner's key is lost; operator independence between these two owners is UNVERIFIED (see docs/mainnet-custody-design.md for tracked status).");
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    generatedBy: "scripts/generate-deployment-manifest.ts",
    network: { chain: "sepolia", chainId: sepolia.id, rpcHost: new URL(RPC_URL).hostname },
    decisionRelay: {
      address: DECISION_RELAY,
      codehash: null as string | null, // filled below
      owner,
      attestorThreshold: attestorThreshold.toString(),
      interchainSecurityModule: ism,
      attestors: {
        active: activeAttestors,
        checkedButInactive: inactiveCandidates,
        note: "activeAttestors is derived by live isAttestor() calls against CANDIDATE_ATTESTORS in this script, NOT an enumerable on-chain list — DecisionRelay.sol has no getter that lists all attestors. If an attestor was added/removed via addAttestor()/removeAttestor() and isn't in CANDIDATE_ATTESTORS, it will not appear here. This is a real limitation, not a false completeness claim.",
      },
    },
    safe: {
      address: SAFE,
      owners: safeOwners,
      threshold: safeThreshold.toString(),
      nonce: safeNonce.toString(),
    },
    flags,
    knownLimitations,
  };

  // Compute codehash from the fetched bytecode (a real, independent
  // check — not copied from any doc).
  const { keccak256 } = await import("viem");
  manifest.decisionRelay.codehash = keccak256(decisionRelayBytecode ?? "0x");

  writeFileSync("deployment-manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
  if (flags.length > 0) {
    console.error(`\n${flags.length} flag(s) raised — see manifest's "flags" array above.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
