import { prisma } from "@/lib/prisma";

// Phase 4, item 5 — customer analytics. Org-scoped (this org's own
// cases only) — a real query-backed computation, not mock data. Reuses
// the same auth boundary as the rest of the customer-facing case API
// (resolveOrgFromRequest), deliberately distinct from the ops
// console's requirePlatformAdmin gate (see api/ops-console/route.ts):
// that surface is cross-tenant internal-ops data, this is one
// customer's own numbers.

export interface AnalyticsResult {
  generatedAt: string;
  disputeCount: number;
  disputeRatePerDay: number;
  avgResolutionTimeHours: number | null;
  appealRate: number;
  reversalRate: number;
  outcomeDistribution: Record<string, number>;
  settlementFailureRate: number;
  avgSettlementDelayHours: number | null;
  byPolicy: Record<string, { count: number; avgResolutionTimeHours: number | null }>;
  byAsset: Record<string, { count: number; settlementFailureRate: number }>;
}

export async function computeOrgAnalytics(organizationId: string, sinceDays = 90): Promise<AnalyticsResult> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const cases = await prisma.case.findMany({
    where: { organizationId, createdAt: { gte: since } },
    include: {
      decisions: { orderBy: { createdAt: "asc" } },
      settlement: { include: { integration: true } },
      policyVersionRecord: { include: { policy: true } },
    },
  });

  const disputeCount = cases.length;
  const disputeRatePerDay = disputeCount / sinceDays;

  const resolvedDurationsHours: number[] = [];
  const outcomeDistribution: Record<string, number> = {};
  let appealedCount = 0;
  let reversedCount = 0;
  let settlementAttempts = 0;
  let settlementFailures = 0;
  const settlementDelaysHours: number[] = [];
  const byPolicy: Record<string, { count: number; totalResolutionHours: number; resolvedCount: number }> = {};
  const byAsset: Record<string, { count: number; failures: number }> = {};

  for (const kase of cases) {
    const finalDecision = kase.decisions[kase.decisions.length - 1];
    if (finalDecision) {
      outcomeDistribution[finalDecision.outcome] = (outcomeDistribution[finalDecision.outcome] ?? 0) + 1;
    }
    if (kase.decisions.length > 1) {
      appealedCount++;
      const first = kase.decisions[0];
      const last = kase.decisions[kase.decisions.length - 1];
      if (first.outcome !== last.outcome) reversedCount++;
    }
    if (kase.status === "FINALIZED" || kase.status === "UNDETERMINED") {
      const resolvedAt = finalDecision?.createdAt ?? kase.updatedAt;
      const hours = (resolvedAt.getTime() - kase.createdAt.getTime()) / (60 * 60 * 1000);
      resolvedDurationsHours.push(hours);

      const policyKey = kase.policyVersionRecord?.policy.key ?? "unbound";
      const entry = byPolicy[policyKey] ?? { count: 0, totalResolutionHours: 0, resolvedCount: 0 };
      entry.count++;
      entry.totalResolutionHours += hours;
      entry.resolvedCount++;
      byPolicy[policyKey] = entry;
    }

    if (finalDecision?.relayTxHash || finalDecision?.relayError) {
      settlementAttempts++;
      if (!finalDecision.relayTxHash) settlementFailures++;
      if (finalDecision.relayTxHash && kase.settlement?.depositConfirmedAt) {
        const delayHours = (finalDecision.createdAt.getTime() - kase.settlement.depositConfirmedAt.getTime()) / (60 * 60 * 1000);
        if (delayHours >= 0) settlementDelaysHours.push(delayHours);
      }
      const asset = kase.settlement?.integration.assetSymbol ?? "unknown";
      const assetEntry = byAsset[asset] ?? { count: 0, failures: 0 };
      assetEntry.count++;
      if (!finalDecision.relayTxHash) assetEntry.failures++;
      byAsset[asset] = assetEntry;
    }
  }

  const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  return {
    generatedAt: new Date().toISOString(),
    disputeCount,
    disputeRatePerDay,
    avgResolutionTimeHours: avg(resolvedDurationsHours),
    appealRate: disputeCount > 0 ? appealedCount / disputeCount : 0,
    reversalRate: appealedCount > 0 ? reversedCount / appealedCount : 0,
    outcomeDistribution,
    settlementFailureRate: settlementAttempts > 0 ? settlementFailures / settlementAttempts : 0,
    avgSettlementDelayHours: avg(settlementDelaysHours),
    byPolicy: Object.fromEntries(
      Object.entries(byPolicy).map(([k, v]) => [k, { count: v.count, avgResolutionTimeHours: v.resolvedCount > 0 ? v.totalResolutionHours / v.resolvedCount : null }])
    ),
    byAsset: Object.fromEntries(Object.entries(byAsset).map(([k, v]) => [k, { count: v.count, settlementFailureRate: v.count > 0 ? v.failures / v.count : 0 }])),
  };
}
