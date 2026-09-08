import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromRequest, authErrorResponse, requireScope } from "@/lib/auth";
import { computeOrgAnalytics } from "@/lib/analytics";

// GET /api/analytics?sinceDays=90 — this org's own dispute/settlement
// analytics. Customer-facing (org-scoped auth, any role including
// VIEWER can read), distinct from the internal ops console's
// cross-tenant, platform-admin-only surface.
export async function GET(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "analytics:read");
  if (scopeError) return scopeError;

  const sinceDaysParam = req.nextUrl.searchParams.get("sinceDays");
  const sinceDays = sinceDaysParam ? Number(sinceDaysParam) : 90;
  if (!Number.isFinite(sinceDays) || sinceDays <= 0) {
    return NextResponse.json({ error: "sinceDays must be a positive number" }, { status: 400 });
  }

  const result = await computeOrgAnalytics(auth.organizationId, sinceDays);
  return NextResponse.json(result);
}
