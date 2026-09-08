import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromRequest, authErrorResponse, requireScope } from "@/lib/auth";
import { buildCaseStatement, buildProofBundle, ReceiptError } from "@/lib/receipts";

// GET /api/cases/:id/statement?type=statement|proof-bundle — downloadable
// case statement or evidence+decision proof bundle. Org-scoped read.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "cases:read");
  if (scopeError) return scopeError;

  const type = req.nextUrl.searchParams.get("type") ?? "statement";
  try {
    const doc = type === "proof-bundle" ? await buildProofBundle(params.id, auth.organizationId) : await buildCaseStatement(params.id, auth.organizationId);
    return NextResponse.json(doc, {
      headers: { "Content-Disposition": `attachment; filename="${params.id}-${type}.json"` },
    });
  } catch (err) {
    if (err instanceof ReceiptError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
