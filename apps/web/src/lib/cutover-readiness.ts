import type { Address } from "viem";
import { getEvmPublicClient } from "@/lib/hyperlane";
import { prisma } from "@/lib/prisma";
import { depositsAbiForVersion } from "@/lib/escrow-version";

// Item D UI: the same real checks scripts/cutover-readiness-check.sh
// performs, ported to TypeScript so the dashboard can surface them
// instead of requiring a CLI + SSH. Deliberately mirrors that script's
// logic exactly rather than reimplementing it differently — two
// implementations of "is it safe to cut over" that could quietly
// disagree would be worse than one CLI-only tool. Read-only: this
// function makes zero writes, on-chain or in the database.

const SAFE_THRESHOLD_ABI = [
  { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const SETTLEMENT_TARGET_ABI = [
  { type: "function", name: "settlementTarget", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "address" }] },
] as const;
const DEPOSITED_EVENT_ABI = {
  type: "event",
  name: "Deposited",
  inputs: [
    { name: "caseId", type: "bytes32", indexed: true },
    { name: "escrowId", type: "bytes32", indexed: true },
    { name: "depositor", type: "address", indexed: true },
    { name: "claimant", type: "address" },
    { name: "respondent", type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

const HYPERLANE_DOMAIN_SEPOLIA = 11155111;
const LOG_SCAN_CHUNK = 9000n;

export interface IntegrationReadiness {
  integrationId: string;
  chain: string;
  escrowContractAddress: string;
  escrowVersion: string;
  active: boolean;
  depositsEverMade: number;
  unsettledEscrowIds: string[];
  currentSettlementTargets: { decisionRelay: string; liveTarget: string; matchesIntegration: boolean }[];
}

export interface CutoverReadinessReport {
  checkedAt: string;
  safeAddress: string | null;
  safeThreshold: number | null;
  integrations: IntegrationReadiness[];
  totalUnsettledV1Deposits: number;
  ready: boolean;
  blockingReasons: string[];
}

async function scanUnsettledDeposits(escrowAddress: Address, version: "V1" | "V2", fromBlock: bigint): Promise<{ everMade: number; unsettled: string[] }> {
  const client = getEvmPublicClient();
  const latest = await client.getBlockNumber();
  const escrowIds = new Set<string>();
  for (let from = fromBlock; from <= latest; from += LOG_SCAN_CHUNK) {
    const to = from + LOG_SCAN_CHUNK > latest ? latest : from + LOG_SCAN_CHUNK;
    const logs = await client.getLogs({ address: escrowAddress, event: DEPOSITED_EVENT_ABI, fromBlock: from, toBlock: to });
    for (const log of logs) {
      if (log.args.escrowId) escrowIds.add(log.args.escrowId);
    }
  }

  const unsettled: string[] = [];
  const abi = depositsAbiForVersion(version);
  for (const escrowId of escrowIds) {
    try {
      const result = (await client.readContract({ address: escrowAddress, abi, functionName: "deposits", args: [escrowId as `0x${string}`] })) as readonly [
        number,
        ...unknown[],
      ];
      if (result[0] === 1 /* DEPOSITED, not yet SETTLED */) unsettled.push(escrowId);
    } catch (err) {
      // A decode failure here is itself a readiness-blocking fact, not
      // something to swallow — surfaced by leaving this escrowId out of
      // "confirmed settled" and letting the caller's blockingReasons
      // logic see everMade > accounted-for.
      console.error(`cutover-readiness: failed to read deposits(${escrowId}) on ${escrowAddress}`, err);
      unsettled.push(escrowId);
    }
  }
  return { everMade: escrowIds.size, unsettled };
}

export async function runCutoverReadinessCheck(params?: { v1EscrowDeployBlock?: bigint }): Promise<CutoverReadinessReport> {
  const client = getEvmPublicClient();
  const blockingReasons: string[] = [];

  const integrations = await prisma.settlementIntegration.findMany({ where: { chain: "sepolia" } });
  const results: IntegrationReadiness[] = [];
  let totalUnsettled = 0;

  for (const integration of integrations) {
    const { everMade, unsettled } = await scanUnsettledDeposits(
      integration.escrowContractAddress as Address,
      integration.escrowVersion,
      params?.v1EscrowDeployBlock ?? 11_600_000n
    );
    totalUnsettled += unsettled.length;
    if (unsettled.length > 0) {
      blockingReasons.push(`${unsettled.length} unsettled deposit(s) on integration ${integration.id} (${integration.escrowContractAddress})`);
    }

    const cases = await prisma.caseSettlement.findMany({ where: { integrationId: integration.id }, include: { case: true } });
    const relayAddresses = [...new Set(cases.map((c) => c.case.settlementContract).filter((a): a is string => Boolean(a)))];
    const currentSettlementTargets: IntegrationReadiness["currentSettlementTargets"] = [];
    for (const relay of relayAddresses) {
      try {
        const liveTarget = await client.readContract({ address: relay as Address, abi: SETTLEMENT_TARGET_ABI, functionName: "settlementTarget", args: [HYPERLANE_DOMAIN_SEPOLIA] });
        const matches = liveTarget.toLowerCase() === integration.escrowContractAddress.toLowerCase();
        currentSettlementTargets.push({ decisionRelay: relay, liveTarget, matchesIntegration: matches });
        if (!matches) blockingReasons.push(`DecisionRelay ${relay}'s settlementTarget does not match integration ${integration.id}`);
      } catch (err) {
        blockingReasons.push(`could not read settlementTarget on DecisionRelay ${relay}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    results.push({
      integrationId: integration.id,
      chain: integration.chain,
      escrowContractAddress: integration.escrowContractAddress,
      escrowVersion: integration.escrowVersion,
      active: integration.active,
      depositsEverMade: everMade,
      unsettledEscrowIds: unsettled,
      currentSettlementTargets,
    });
  }

  let safeAddress: string | null = null;
  let safeThreshold: number | null = null;
  if (process.env.SAFE_ADDRESS) {
    safeAddress = process.env.SAFE_ADDRESS;
    try {
      const threshold = await client.readContract({ address: safeAddress as Address, abi: SAFE_THRESHOLD_ABI, functionName: "getThreshold" });
      safeThreshold = Number(threshold);
      if (safeThreshold !== 2) blockingReasons.push(`Safe threshold is ${safeThreshold}, expected 2`);
    } catch (err) {
      blockingReasons.push(`could not read Safe threshold: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const openCriticalFindings = await prisma.reconciliationFinding.count({
    where: { resolvedAt: null, type: { in: ["ZERO_SETTLEMENT_TARGET", "TARGET_INTEGRATION_MISMATCH", "ESCROW_VERSION_MISMATCH"] } },
  });
  if (openCriticalFindings > 0) blockingReasons.push(`${openCriticalFindings} unresolved critical reconciliation finding(s)`);

  return {
    checkedAt: new Date().toISOString(),
    safeAddress,
    safeThreshold,
    integrations: results,
    totalUnsettledV1Deposits: totalUnsettled,
    ready: blockingReasons.length === 0,
    blockingReasons,
  };
}
