import { prisma } from "@/lib/prisma";

// Phase 5, item B: metering. Deliberately NOT a persisted UsageRecord
// table — every number here is derivable on demand from tables that
// already exist (Case/Evidence/Decision/CaseSettlement), the same
// "real query over existing data, not a new parallel aggregation"
// choice analytics.ts (Phase 4) already made for org analytics. A
// persisted ledger would need its own backfill/reconciliation story
// for zero benefit at this volume.

export interface UsagePeriod {
  /** Calendar-month period key, e.g. "2026-09". */
  period: string;
  periodStart: string;
  periodEnd: string;
}

export interface OrgUsage extends UsagePeriod {
  organizationId: string;
  cases: number;
  evidenceSubmissions: number;
  decisions: number;
  settlements: number;
}

/** Parses "YYYY-MM" into a [start, end) calendar-month range in UTC. Defaults to the current month. */
export function resolvePeriod(periodParam: string | null): UsagePeriod {
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth(); // 0-indexed

  if (periodParam) {
    const match = /^(\d{4})-(\d{2})$/.exec(periodParam);
    if (!match) {
      throw new Error("period must be formatted as YYYY-MM");
    }
    year = Number(match[1]);
    month = Number(match[2]) - 1;
    if (month < 0 || month > 11) {
      throw new Error("period month must be between 01 and 12");
    }
  }

  const periodStart = new Date(Date.UTC(year, month, 1));
  const periodEnd = new Date(Date.UTC(year, month + 1, 1));
  return {
    period: `${year}-${String(month + 1).padStart(2, "0")}`,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  };
}

export async function computeOrgUsage(organizationId: string, periodParam: string | null): Promise<OrgUsage> {
  const { period, periodStart, periodEnd } = resolvePeriod(periodParam);
  const start = new Date(periodStart);
  const end = new Date(periodEnd);

  const [cases, evidenceSubmissions, decisions, settlements] = await Promise.all([
    prisma.case.count({ where: { organizationId, createdAt: { gte: start, lt: end } } }),
    prisma.evidence.count({ where: { case: { organizationId }, createdAt: { gte: start, lt: end } } }),
    prisma.decision.count({ where: { case: { organizationId }, createdAt: { gte: start, lt: end } } }),
    prisma.caseSettlement.count({ where: { case: { organizationId }, createdAt: { gte: start, lt: end } } }),
  ]);

  return { organizationId, period, periodStart, periodEnd, cases, evidenceSubmissions, decisions, settlements };
}
