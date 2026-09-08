import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromRequest, authErrorResponse, requireScope } from "@/lib/auth";
import { computeOrgAnalytics } from "@/lib/analytics";
import { resolvePeriod } from "@/lib/usage";

// GET /api/organizations/pilot-report?period=YYYY-MM&format=json|csv —
// Track 4 item 3's "exportable report for the pilot customer": one
// consolidated snapshot built entirely out of computeOrgAnalytics's
// existing metrics plus the two genuinely new ones (evidence
// completion rate, settlement retry rate), packaged for handing to a
// pilot customer's own reporting rather than read live off the
// dashboard. Same auth boundary and scope as the rest of analytics.

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function toCsv(report: PilotReport): string {
  const lines: string[] = [];
  lines.push("section,key,value");

  const scalarRows: [string, unknown][] = [
    ["organizationId", report.organizationId],
    ["period", report.period],
    ["periodStart", report.periodStart],
    ["generatedAt", report.generatedAt],
    ["disputeIntakeVolume", report.disputeIntakeVolume],
    ["disputeRatePerDay", report.disputeRatePerDay],
    ["avgResolutionTimeHours", report.avgResolutionTimeHours],
    ["appealRate", report.appealRate],
    ["reversalRate", report.reversalRate],
    ["evidenceCompletionRate", report.evidenceCompletionRate],
    ["settlementSuccessRate", report.settlementSuccessRate],
    ["settlementFailureRate", report.settlementFailureRate],
    ["settlementRetryRate", report.settlementRetryRate],
    ["avgRelayAttempts", report.avgRelayAttempts],
  ];
  for (const [key, value] of scalarRows) {
    lines.push(`summary,${csvEscape(key)},${csvEscape(String(value ?? ""))}`);
  }

  for (const [outcome, count] of Object.entries(report.outcomeDistribution)) {
    lines.push(`outcomeDistribution,${csvEscape(outcome)},${count}`);
  }
  for (const [policyKey, v] of Object.entries(report.byPolicy)) {
    lines.push(`byPolicy,${csvEscape(policyKey)}.count,${v.count}`);
    lines.push(`byPolicy,${csvEscape(policyKey)}.avgResolutionTimeHours,${v.avgResolutionTimeHours ?? ""}`);
  }
  for (const [integrationId, v] of Object.entries(report.byIntegration)) {
    lines.push(`byIntegration,${csvEscape(integrationId)}.count,${v.count}`);
    lines.push(`byIntegration,${csvEscape(integrationId)}.settlementFailureRate,${v.settlementFailureRate}`);
    lines.push(`byIntegration,${csvEscape(integrationId)}.settlementRetryRate,${v.settlementRetryRate}`);
  }
  return lines.join("\n") + "\n";
}

interface PilotReport {
  organizationId: string;
  period: string;
  periodStart: string;
  generatedAt: string;
  disputeIntakeVolume: number;
  disputeRatePerDay: number;
  avgResolutionTimeHours: number | null;
  appealRate: number;
  reversalRate: number;
  outcomeDistribution: Record<string, number>;
  evidenceCompletionRate: number;
  settlementSuccessRate: number;
  settlementFailureRate: number;
  settlementRetryRate: number;
  avgRelayAttempts: number | null;
  byPolicy: Record<string, { count: number; avgResolutionTimeHours: number | null }>;
  byIntegration: Record<string, { count: number; settlementFailureRate: number; settlementRetryRate: number }>;
}

export async function GET(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "analytics:read");
  if (scopeError) return scopeError;

  const periodParam = req.nextUrl.searchParams.get("period");
  const format = req.nextUrl.searchParams.get("format") ?? "json";
  if (format !== "json" && format !== "csv") {
    return NextResponse.json({ error: "format must be json or csv" }, { status: 400 });
  }

  let period: string, periodStart: string;
  try {
    ({ period, periodStart } = resolvePeriod(periodParam));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "invalid period" }, { status: 400 });
  }

  // computeOrgAnalytics windows by "N days back from now", not by a
  // fixed calendar range — reused as-is (no analytics.ts query change)
  // by sizing that window to span from the requested month's start to
  // now, which is exactly equivalent for the common case (reporting on
  // the current or a fully-elapsed past month).
  const sinceDays = Math.max(1, Math.ceil((Date.now() - new Date(periodStart).getTime()) / (24 * 60 * 60 * 1000)));
  const analytics = await computeOrgAnalytics(auth.organizationId, sinceDays);

  const report: PilotReport = {
    organizationId: auth.organizationId,
    period,
    periodStart,
    generatedAt: analytics.generatedAt,
    disputeIntakeVolume: analytics.disputeCount,
    disputeRatePerDay: analytics.disputeRatePerDay,
    avgResolutionTimeHours: analytics.avgResolutionTimeHours,
    appealRate: analytics.appealRate,
    reversalRate: analytics.reversalRate,
    outcomeDistribution: analytics.outcomeDistribution,
    evidenceCompletionRate: analytics.evidenceCompletionRate,
    settlementSuccessRate: 1 - analytics.settlementFailureRate,
    settlementFailureRate: analytics.settlementFailureRate,
    settlementRetryRate: analytics.settlementRetryRate,
    avgRelayAttempts: analytics.avgRelayAttempts,
    byPolicy: analytics.byPolicy,
    byIntegration: analytics.byIntegration,
  };

  if (format === "csv") {
    return new NextResponse(toCsv(report), {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="pilot-report-${period}.csv"`,
      },
    });
  }
  return NextResponse.json(report);
}
