import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromRequest, authErrorResponse, requireScope } from "@/lib/auth";
import { computeStubInvoice } from "@/lib/billing";

// GET /api/organizations/invoices?period=YYYY-MM — a computed invoice
// PREVIEW for one calendar month. See lib/billing.ts's header comment:
// this is a stub with no real payment processing whatsoever. It always
// returns status "STUB_NOT_INVOICED" and never charges anything.
export async function GET(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "organizations:read");
  if (scopeError) return scopeError;

  const periodParam = req.nextUrl.searchParams.get("period");
  try {
    const invoice = await computeStubInvoice(auth.organizationId, periodParam);
    return NextResponse.json(invoice);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "invalid period" }, { status: 400 });
  }
}
