import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireScope } from "@/lib/auth";
import { caseVisibilityWhere } from "@/lib/case-access";

// GET /api/cases/reviews?status=PENDING — org-wide review queue. Every
// existing review endpoint (/api/cases/:id/review) is scoped to one
// case; there was no way to list all of an org's open CaseReviews
// without already knowing their case IDs, which is exactly the gap the
// review-queue dashboard needs filled. CaseReview has no organizationId
// column of its own (see schema.prisma), so this joins through Case and
// reuses the same visibility rule as GET /api/cases.
export async function GET(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "cases:read");
  if (scopeError) return scopeError;

  const statusParam = req.nextUrl.searchParams.get("status");
  const status = statusParam === "APPROVED" || statusParam === "REJECTED" || statusParam === "PENDING" ? statusParam : undefined;

  const reviews = await prisma.caseReview.findMany({
    where: {
      status,
      case: { organizationId: auth.organizationId, ...caseVisibilityWhere(auth) },
    },
    include: {
      case: { select: { id: true, claim: true, amount: true, currency: true, status: true, claimantRef: true, respondentRef: true } },
      approvals: { orderBy: { createdAt: "asc" } },
      notes: { orderBy: { createdAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(reviews);
}
