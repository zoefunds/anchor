import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromRequest, authErrorResponse, requireScope } from "@/lib/auth";
import { POLICIES } from "@/lib/policies";

// GET /api/policies — lists available adjudication policies, so a caller
// (agent or dashboard) can discover what's supported and what evidence
// each one requires before creating a case. Auth-gated like everything
// else, even though the policy list itself isn't org-specific — keeps the
// API surface consistently behind auth rather than leaking product
// details to unauthenticated callers.
export async function GET(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }
  const scopeError = requireScope(auth, "policies:read");
  if (scopeError) return scopeError;
  return NextResponse.json(Object.values(POLICIES));
}
