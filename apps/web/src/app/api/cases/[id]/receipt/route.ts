import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromRequest, authErrorResponse } from "@/lib/auth";
import { buildDepositReceipt, buildSettlementReceipt, ReceiptError } from "@/lib/receipts";

// GET /api/cases/:id/receipt?type=deposit|settlement — downloadable
// deposit receipt or release/refund/partial-settlement receipt.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);

  const type = req.nextUrl.searchParams.get("type") ?? "settlement";
  try {
    const doc = type === "deposit" ? await buildDepositReceipt(params.id, auth.organizationId) : await buildSettlementReceipt(params.id, auth.organizationId);
    return NextResponse.json(doc, {
      headers: { "Content-Disposition": `attachment; filename="${params.id}-${type}-receipt.json"` },
    });
  } catch (err) {
    if (err instanceof ReceiptError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
