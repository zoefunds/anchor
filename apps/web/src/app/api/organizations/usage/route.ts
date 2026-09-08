import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromRequest, authErrorResponse, requireScope } from "@/lib/auth";
import { computeOrgUsage } from "@/lib/usage";

// GET /api/organizations/usage?period=YYYY-MM — this org's own metered
// usage for one calendar month (defaults to the current month). See
// lib/usage.ts for why this is a live query over existing tables
// rather than a persisted UsageRecord ledger.
export async function GET(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "organizations:read");
  if (scopeError) return scopeError;

  const periodParam = req.nextUrl.searchParams.get("period");
  try {
    const usage = await computeOrgUsage(auth.organizationId, periodParam);
    return NextResponse.json(usage);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "invalid period" }, { status: 400 });
  }
}
