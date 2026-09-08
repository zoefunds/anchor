import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromRequest, authErrorResponse, requireScope } from "@/lib/auth";
import { buildSettlementsCsv, buildReconciliationExport } from "@/lib/receipts";

// GET /api/organizations/settlements/export?format=csv|json — normalized
// CSV for a customer's accounting system, or the machine-readable
// reconciliation export (JSON, includes the audit-anchor chain tail).
export async function GET(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "settlements:export");
  if (scopeError) return scopeError;

  const format = req.nextUrl.searchParams.get("format") ?? "csv";
  if (format === "json") {
    const doc = await buildReconciliationExport(auth.organizationId);
    return NextResponse.json(doc, {
      headers: { "Content-Disposition": `attachment; filename="reconciliation-export.json"` },
    });
  }

  const csv = await buildSettlementsCsv(auth.organizationId);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="settlements-export.csv"`,
    },
  });
}
