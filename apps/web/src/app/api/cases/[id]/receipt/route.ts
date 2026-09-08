import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromRequest, authErrorResponse, requireScope } from "@/lib/auth";
import { buildDepositReceipt, buildSettlementReceipt, ReceiptError } from "@/lib/receipts";
import { generateDepositReceiptPdf, generateSettlementReceiptPdf } from "@/lib/pdf-documents";

// GET /api/cases/:id/receipt?type=deposit|settlement&format=json|pdf —
// downloadable deposit receipt or release/refund/partial-settlement
// receipt. format=pdf renders the same underlying data via
// lib/pdf-documents.ts rather than re-deriving it.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "cases:read");
  if (scopeError) return scopeError;

  const type = req.nextUrl.searchParams.get("type") ?? "settlement";
  const format = req.nextUrl.searchParams.get("format") ?? "json";
  try {
    if (format === "pdf") {
      const pdfBytes = await (type === "deposit" ? generateDepositReceiptPdf(params.id, auth.organizationId) : generateSettlementReceiptPdf(params.id, auth.organizationId));
      return new NextResponse(Buffer.from(pdfBytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${params.id}-${type}-receipt.pdf"`,
        },
      });
    }
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
