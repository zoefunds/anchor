#!/usr/bin/env node
// Priority 2, item 8 — read-only production inventory. Reports every
// SettlementIntegration: escrow address, registered version (and
// whether the live contract still actually matches it), the real
// DecisionRelay.settlementTarget mapping for its case's domain, and
// every unsettled deposit found by scanning real Deposited events.
// No mutation of any kind — safe to run at any time, including
// repeatedly. Run from apps/web (needs its own DATABASE_URL and
// HYPERLANE_RELAY_RPC_URL) via:
//
//   cd apps/web && node ../../scripts/production-inventory.mjs
//
// or, against production, over SSH into the worker (same pattern used
// throughout this session's manual verification):
//
//   flyctl ssh console -a anc-hor-worker -C \
//     "sh -c 'cd /repo/apps/web && /repo/node_modules/.bin/tsx /path/to/this-uploaded/production-inventory.mjs'"

const webRoot = new URL("../apps/web/", import.meta.url);
process.chdir(webRoot.pathname);

const { prisma } = await import(new URL("src/lib/prisma.ts", webRoot).href);
const { createPublicClient, http, encodeFunctionData } = await import("viem");
const { sepolia } = await import("viem/chains");

const HYPERLANE_DOMAIN_SEPOLIA = 11155111;

const DECISION_RELAY_ABI = [
  { type: "function", name: "settlementTarget", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "address" }] },
];
const DEPOSITS_SELECTOR_ABI = [
  { type: "function", name: "deposits", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [] },
];

function getClient() {
  return createPublicClient({ chain: sepolia, transport: http(process.env.HYPERLANE_RELAY_RPC_URL) });
}

function encodeDepositsCall(escrowId) {
  return encodeFunctionData({ abi: DEPOSITS_SELECTOR_ABI, functionName: "deposits", args: [escrowId ?? "0x" + "00".repeat(32)] });
}

async function detectLiveVersion(client, address) {
  try {
    const data = encodeDepositsCall();
    const result = await client.call({ to: address, data });
    const len = ((result.data ?? "0x").length - 2) / 2;
    if (len === 128) return "V1";
    if (len === 192) return "V2";
    return `UNKNOWN(${len} bytes)`;
  } catch (err) {
    return `UNREADABLE(${err.shortMessage ?? err.message})`;
  }
}

async function findUnsettledDeposits(client, escrowAddress, fromBlock) {
  const latest = await client.getBlockNumber();
  const CHUNK = 9000n;
  const escrowIds = new Set();
  for (let from = fromBlock; from <= latest; from += CHUNK) {
    const to = from + CHUNK > latest ? latest : from + CHUNK;
    const logs = await client.getLogs({
      address: escrowAddress,
      event: { type: "event", name: "Deposited", inputs: [{ name: "caseId", type: "bytes32", indexed: true }, { name: "escrowId", type: "bytes32", indexed: true }, { name: "depositor", type: "address", indexed: true }, { name: "claimant", type: "address" }, { name: "respondent", type: "address" }, { name: "amount", type: "uint256" }] },
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) escrowIds.add(log.args.escrowId);
  }

  const unsettled = [];
  for (const escrowId of escrowIds) {
    const data = encodeDepositsCall(escrowId);
    const result = await client.call({ to: escrowAddress, data });
    const raw = result.data ?? "0x";
    // status is the first 32-byte word regardless of V1/V2 shape.
    const status = parseInt(raw.slice(2, 66), 16);
    if (status === 1) unsettled.push(escrowId);
  }
  return { totalDepositsEverMade: escrowIds.size, unsettled };
}

async function main() {
  const client = getClient();
  const integrations = await prisma.settlementIntegration.findMany({ include: { organization: true } });

  console.log(`=== Production inventory — ${new Date().toISOString()} ===`);
  console.log(`${integrations.length} settlement integration(s) found.\n`);

  let totalUnsettled = 0;
  let totalCriticalFindings = 0;

  for (const integration of integrations) {
    console.log(`--- ${integration.id} (org: ${integration.organization.name}) ---`);
    console.log(`  chain:              ${integration.chain}`);
    console.log(`  escrow address:     ${integration.escrowContractAddress}`);
    console.log(`  registered version: ${integration.escrowVersion}`);
    console.log(`  active:             ${integration.active}`);

    const liveVersion = await detectLiveVersion(client, integration.escrowContractAddress);
    const versionMatches = liveVersion === integration.escrowVersion;
    console.log(`  live version:       ${liveVersion} ${versionMatches ? "(matches)" : "*** MISMATCH ***"}`);
    if (!versionMatches) totalCriticalFindings++;

    // Real settlementTarget mapping — read for every case bound to
    // this integration's own settlementContract (there can be more
    // than one DecisionRelay in play across cases, in principle).
    const cases = await prisma.caseSettlement.findMany({
      where: { integrationId: integration.id },
      include: { case: true },
    });
    const relayAddresses = [...new Set(cases.map((c) => c.case.settlementContract).filter(Boolean))];
    for (const relay of relayAddresses) {
      try {
        const target = await client.readContract({ address: relay, abi: DECISION_RELAY_ABI, functionName: "settlementTarget", args: [HYPERLANE_DOMAIN_SEPOLIA] });
        const targetMatches = target.toLowerCase() === integration.escrowContractAddress.toLowerCase();
        console.log(`  DecisionRelay ${relay} settlementTarget: ${target} ${targetMatches ? "(matches)" : "*** MISMATCH ***"}`);
        if (!targetMatches) totalCriticalFindings++;
      } catch (err) {
        console.log(`  DecisionRelay ${relay} settlementTarget: UNREADABLE (${err.shortMessage ?? err.message})`);
        totalCriticalFindings++;
      }
    }

    try {
      const deployBlock = process.env[`ESCROW_DEPLOY_BLOCK_${integration.id}`] ? BigInt(process.env[`ESCROW_DEPLOY_BLOCK_${integration.id}`]) : 11_600_000n;
      const { totalDepositsEverMade, unsettled } = await findUnsettledDeposits(client, integration.escrowContractAddress, deployBlock);
      console.log(`  deposits ever made: ${totalDepositsEverMade}`);
      console.log(`  unsettled deposits: ${unsettled.length}${unsettled.length > 0 ? " *** " + unsettled.join(", ") : ""}`);
      totalUnsettled += unsettled.length;
    } catch (err) {
      console.log(`  unsettled deposits: COULD NOT SCAN (${err.message})`);
    }

    console.log("");
  }

  const openFindings = await prisma.reconciliationFinding.count({ where: { resolvedAt: null } });
  console.log(`=== Summary ===`);
  console.log(`Total unsettled deposits across all integrations: ${totalUnsettled}`);
  console.log(`Open ReconciliationFinding rows: ${openFindings}`);
  console.log(`Critical findings surfaced by this inventory run: ${totalCriticalFindings}`);
  console.log(totalUnsettled === 0 && totalCriticalFindings === 0 && openFindings === 0 ? "READY" : "NOT READY");

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
