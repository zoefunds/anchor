import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromRequest, authErrorResponse, requireScope } from "@/lib/auth";
import { buildCaseStatement, buildProofBundle, ReceiptError } from "@/lib/receipts";
import { generateCaseStatementPdf, generateEvidenceReceiptPdf, generateDecisionRecordPdf, generateAppealRecordPdf } from "@/lib/pdf-documents";

// GET /api/cases/:id/statement?type=statement|proof-bundle|decision|appeal&format=json|pdf
// — downloadable case statement, evidence+decision proof bundle,
// decision record, or appeal record. Org-scoped read. format=pdf
// renders the same underlying data via lib/pdf-documents.ts rather than
// re-deriving it.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "cases:read");
  if (scopeError) return scopeError;

  const type = req.nextUrl.searchParams.get("type") ?? "statement";
  const format = req.nextUrl.searchParams.get("format") ?? "json";
  try {
    if (format === "pdf") {
      const pdfBytes = await (
        type === "proof-bundle"
          ? generateEvidenceReceiptPdf(params.id, auth.organizationId)
          : type === "decision"
            ? generateDecisionRecordPdf(params.id, auth.organizationId, req.nextUrl.searchParams.get("decisionId") ?? undefined)
            : type === "appeal"
              ? generateAppealRecordPdf(params.id, auth.organizationId)
              : generateCaseStatementPdf(params.id, auth.organizationId)
      );
      return new NextResponse(Buffer.from(pdfBytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${params.id}-${type}.pdf"`,
        },
      });
    }
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
