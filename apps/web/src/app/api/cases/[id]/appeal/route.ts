import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess, requireScope } from "@/lib/auth";
import { canAccessCase } from "@/lib/case-access";
import { triggerAppeal } from "@/lib/appeal-service";

// POST /api/cases/:id/appeal — contest a decision within its appeal
// window and trigger exactly one re-adjudication round. The contract
// itself caps this at one appeal (see adjudicator.py's MAX_APPEALS) —
// this route's own checks (status + window, in lib/appeal-service.ts)
// are the app-level gate that keeps a party from even attempting a
// second one, but the contract is the actual source of truth and will
// reject it on-chain regardless. See api/public/cases/:id/appeal for the
// party-token-authenticated equivalent of this route.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }
  const writeError = requireWriteAccess(auth);
  if (writeError) return writeError;
  const scopeError = requireScope(auth, "cases:write");
  if (scopeError) return scopeError;

  const kase = await prisma.case.findUnique({
    where: { id: (await params).id },
    include: { decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const { reason } = await req.json().catch(() => ({ reason: undefined }));
  const reasonStr = typeof reason === "string" ? reason : undefined;

  const errorResponse = await triggerAppeal(kase, kase.decisions[0], reasonStr, {
    organizationId: auth.organizationId,
    memberId: auth.memberId,
    apiKeyId: auth.apiKeyId,
    metadata: { reason: reasonStr },
  });
  if (errorResponse) return errorResponse;

  return NextResponse.json(
    { note: "Appeal accepted. Re-adjudication started. Poll GET /api/cases/:id for status/decision." },
    { status: 202 }
  );
}
