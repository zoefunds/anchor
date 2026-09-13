// Incident recovery, topology-freeze phase (2026-09-13): the single
// command that proves deployment-registry.ts's ACTIVE_SEPOLIA_TOPOLOGY
// is not just a committed file someone believes is current, but is
// independently, live-verifiable against actual Sepolia chain state
// right now. Every value below is read from chain, never assumed —
// this is deliberately a DIFFERENT check than
// generate-deployment-manifest.ts's own drift flags (that script checks
// live state against a hardcoded expected Safe address; this one checks
// live state against the registry's OWN declared topology, including
// fields the manifest generator doesn't touch at all: mailbox liveness,
// Escrow's own decisionRelay() binding, and source/destination domain
// agreement between the registry and the dispatch package's own
// HYPERLANE_DOMAIN constant).
//
// Run: npx tsx scripts/verify-active-topology.ts
// Exit code 0 = zero drift. Non-zero = at least one check failed; see
// stderr for exactly which one(s).
import { createPublicClient, http, type Address } from "viem";
import { sepolia } from "viem/chains";
import { ACTIVE_SEPOLIA_TOPOLOGY, ACTIVE_VALIDATORS, RETIRED_SEPOLIA_ADDRESSES } from "../src/lib/deployment-registry";
import { HYPERLANE_DOMAIN } from "@anchor/hyperlane-relay";

const RPC_URL = process.env.HYPERLANE_RELAY_RPC_URL ?? "https://ethereum-sepolia.publicnode.com";

const DECISION_RELAY_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "attestorThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "attestorCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isAttestor", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "interchainSecurityModule", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "mailbox", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "trustedSender", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "settlementTarget", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "settlementMode", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "uint8" }] },
  { type: "function", name: "directSettlementTarget", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const ESCROW_ABI = [
  { type: "function", name: "decisionRelay", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function main() {
  const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
  const t = ACTIVE_SEPOLIA_TOPOLOGY;
  const results: CheckResult[] = [];

  const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

  // 1. Domain agreement: registry vs. the dispatch package's own constant
  // — these are two independently-maintained sources (a TS object here,
  // a separate exported const in packages/hyperlane-relay) that must
  // never silently disagree, since a mismatch here would mean the app
  // and the actual dispatch code are targeting different domains
  // without either side knowing.
  check(
    "source/destination domain agreement (registry vs. dispatch package)",
    t.sourceDomain === HYPERLANE_DOMAIN.sepolia && t.destinationDomain === HYPERLANE_DOMAIN.sepolia,
    `registry: source=${t.sourceDomain} destination=${t.destinationDomain}; dispatch package HYPERLANE_DOMAIN.sepolia=${HYPERLANE_DOMAIN.sepolia}`
  );

  // 2. Mailbox is live code, not an EOA or empty address.
  const mailboxCode = await client.getCode({ address: t.mailbox });
  check("mailbox has deployed bytecode", !!mailboxCode && mailboxCode !== "0x", `mailbox=${t.mailbox} codeLength=${mailboxCode?.length ?? 0}`);

  // 3. DecisionRelay's own mailbox() matches the registry's mailbox.
  const relayMailbox = await client.readContract({ address: t.decisionRelay, abi: DECISION_RELAY_ABI, functionName: "mailbox" });
  check("DecisionRelay.mailbox() matches registry", relayMailbox.toLowerCase() === t.mailbox.toLowerCase(), `live=${relayMailbox} registry=${t.mailbox}`);

  // 4. DecisionRelay.interchainSecurityModule() matches the registry's ISM.
  const liveIsm = await client.readContract({ address: t.decisionRelay, abi: DECISION_RELAY_ABI, functionName: "interchainSecurityModule" });
  check("DecisionRelay.interchainSecurityModule() matches registry", liveIsm.toLowerCase() === t.ism.toLowerCase(), `live=${liveIsm} registry=${t.ism}`);

  // 5. Escrow's own immutable decisionRelay() matches the registry's
  // active DecisionRelay — the single most important check post-Phase-2:
  // this is what would have silently caught "the escrow can never be
  // reached by the new relay" before ever calling attestedSettle() for
  // real.
  const liveEscrowRelay = await client.readContract({ address: t.escrow, abi: ESCROW_ABI, functionName: "decisionRelay" });
  check("Escrow.decisionRelay() matches registry's active DecisionRelay", liveEscrowRelay.toLowerCase() === t.decisionRelay.toLowerCase(), `live=${liveEscrowRelay} registry=${t.decisionRelay}`);

  // 6. Owner, attestor set, and threshold.
  const [owner, attestorThreshold, attestorCount] = await Promise.all([
    client.readContract({ address: t.decisionRelay, abi: DECISION_RELAY_ABI, functionName: "owner" }),
    client.readContract({ address: t.decisionRelay, abi: DECISION_RELAY_ABI, functionName: "attestorThreshold" }),
    client.readContract({ address: t.decisionRelay, abi: DECISION_RELAY_ABI, functionName: "attestorCount" }),
  ]);
  check("attestorThreshold matches registry", Number(attestorThreshold) === t.attestorThreshold, `live=${attestorThreshold} registry=${t.attestorThreshold}`);

  const attestorAddresses: Address[] = ["0x3261CEF8Ca14FCc9EF1Cd584209D7c3b7f578b70", "0xfFC936AEab8220bFD283f3016356F67EEb32130B", "0x6F1A0EE85f08C54669E33103486D98D947Efc043"];
  const membership = await Promise.all(attestorAddresses.map((a) => client.readContract({ address: t.decisionRelay, abi: DECISION_RELAY_ABI, functionName: "isAttestor", args: [a] })));
  const activeCount = membership.filter(Boolean).length;
  check("known attestor set is exactly the active attestors", activeCount === Number(attestorCount) && membership.every(Boolean), `active=${activeCount}/${attestorAddresses.length} known, on-chain attestorCount=${attestorCount}`);

  // 7. Settlement wiring for the active domain.
  const trustedSenderBytes32 = await client.readContract({ address: t.decisionRelay, abi: DECISION_RELAY_ABI, functionName: "trustedSender", args: [t.destinationDomain] });
  const expectedTrustedSenderBytes32 = `0x${"0".repeat(24)}${t.trustedSenderAddress.slice(2).toLowerCase()}`;
  check("trustedSender configured for the active domain", trustedSenderBytes32.toLowerCase() === expectedTrustedSenderBytes32, `live=${trustedSenderBytes32} expected=${expectedTrustedSenderBytes32}`);

  const settlementTarget = await client.readContract({ address: t.decisionRelay, abi: DECISION_RELAY_ABI, functionName: "settlementTarget", args: [t.destinationDomain] });
  check("settlementTarget configured to the active Escrow", settlementTarget.toLowerCase() === t.escrow.toLowerCase(), `live=${settlementTarget} registry=${t.escrow}`);

  const settlementMode = await client.readContract({ address: t.decisionRelay, abi: DECISION_RELAY_ABI, functionName: "settlementMode", args: [t.destinationDomain] });
  check("settlementMode is SETTLEMENT (1)", Number(settlementMode) === 1, `live=${settlementMode}`);

  const directSettlementTarget = await client.readContract({ address: t.decisionRelay, abi: DECISION_RELAY_ABI, functionName: "directSettlementTarget" });
  check("directSettlementTarget configured to the active Escrow", directSettlementTarget.toLowerCase() === t.escrow.toLowerCase(), `live=${directSettlementTarget} registry=${t.escrow}`);

  // 8. Retired addresses are genuinely distinct from active ones — a
  // cheap, permanent guard against the registry itself ever
  // accidentally aliasing an active slot to a retired address.
  const retiredAddresses = Object.values(RETIRED_SEPOLIA_ADDRESSES).map((a) => a.toLowerCase());
  const activeAddresses = [t.mailbox, t.merkleTreeHook, t.validatorAnnounce, t.ism, t.decisionRelay, t.escrow].map((a) => a.toLowerCase());
  const overlap = activeAddresses.filter((a) => retiredAddresses.includes(a));
  check("no active address is also listed as retired", overlap.length === 0, overlap.length ? `overlap: ${overlap.join(", ")}` : "no overlap");

  // 9. Governance flag (informational — known, tracked, does not fail this check on its own).
  const knownGovernanceGap = owner.toLowerCase() !== "0xc200534f7debf2816c085c5a156abd686fa19f4c";

  // --- report ---
  console.log(`\nActive Sepolia topology (source: apps/web/src/lib/deployment-registry.ts)\n`);
  console.log(`  Mailbox:               ${t.mailbox}`);
  console.log(`  MerkleTreeHook:        ${t.merkleTreeHook}`);
  console.log(`  ValidatorAnnounce:     ${t.validatorAnnounce}`);
  console.log(`  ISM:                   ${t.ism}`);
  console.log(`  DecisionRelay:         ${t.decisionRelay}`);
  console.log(`  Escrow:                ${t.escrow}`);
  console.log(`  Owner (live):          ${owner}${knownGovernanceGap ? "  [KNOWN GAP: not the Safe]" : ""}`);
  console.log(`  Attestor threshold:    ${attestorThreshold} of ${attestorCount}`);
  console.log(`  Validators:            ${ACTIVE_VALIDATORS.map((v) => v.label).join(", ")}`);
  console.log(`  Source/dest domain:    ${t.sourceDomain} / ${t.destinationDomain}\n`);

  console.log(`Checks:`);
  for (const r of results) {
    console.log(`  [${r.ok ? "PASS" : "FAIL"}] ${r.name} — ${r.detail}`);
  }

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) FAILED — topology has drifted from the registry. Do not treat this deployment as verified.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${results.length} checks passed — zero drift between the registry and live Sepolia state.`);
    if (knownGovernanceGap) {
      console.log(`(Governance gap above is a known, tracked limitation — see deployment-manifest.json's "flags" — and does not count as drift for this check.)`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
