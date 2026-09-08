import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireScope } from "@/lib/auth";
import { caseVisibilityWhere } from "@/lib/case-access";
import { recordManualOverride, isManualOverrideReason } from "@/lib/kyc/kyc-gate";

// GET /api/kyc/verifications?status=... — operator listing for
// settings/kyc/page.tsx. Deliberately selects only provider references
// (sessionId, providerReference) plus status/dates, never `decision`
// (the raw provider payload) — that column can carry the provider's
// own PII-adjacent fields (name-match results, document metadata) and
// has no reason to leave the server for a list view.
export async function GET(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "cases:read");
  if (scopeError) return scopeError;

  const statusParam = req.nextUrl.searchParams.get("status") ?? undefined;

  const verifications = await prisma.partyVerification.findMany({
    where: {
      status: statusParam as never,
      case: { organizationId: auth.organizationId, ...caseVisibilityWhere(auth) },
    },
    select: {
      id: true,
      caseId: true,
      role: true,
      provider: true,
      providerReference: true,
      sessionId: true,
      status: true,
      jurisdiction: true,
      expiresAt: true,
      createdAt: true,
      updatedAt: true,
      case: { select: { claim: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  return NextResponse.json(verifications);
}

// POST /api/kyc/verifications — manual-override action, gated to a
// fixed set of documented provider-error reasons (see kyc-gate.ts's
// OVERRIDE_REASONS) plus a required free-text note. Writes both a
// PartyVerificationEvent and an AuditLog row (recordManualOverride).
export async function POST(req: NextRequest) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const scopeError = requireScope(auth, "cases:write");
  if (scopeError) return scopeError;
  if (!auth.memberId) {
    return NextResponse.json({ error: "manual overrides require an org member session, not an API key" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const { partyVerificationId, reason, note, toStatus } = body ?? {};
  if (typeof partyVerificationId !== "string" || !partyVerificationId) {
    return NextResponse.json({ error: "partyVerificationId is required" }, { status: 400 });
  }
  if (typeof reason !== "string" || !isManualOverrideReason(reason)) {
    return NextResponse.json({ error: "reason must be one of the documented override reasons" }, { status: 400 });
  }
  if (typeof note !== "string" || !note.trim()) {
    return NextResponse.json({ error: "note is required" }, { status: 400 });
  }
  if (toStatus !== "APPROVED" && toStatus !== "DECLINED") {
    return NextResponse.json({ error: "toStatus must be APPROVED or DECLINED" }, { status: 400 });
  }

  const verification = await prisma.partyVerification.findUnique({
    where: { id: partyVerificationId },
    include: { case: { select: { organizationId: true } } },
  });
  if (!verification || verification.case.organizationId !== auth.organizationId) {
    return NextResponse.json({ error: "verification not found" }, { status: 404 });
  }

  await recordManualOverride({
    partyVerificationId,
    organizationId: auth.organizationId,
    actingMemberId: auth.memberId,
    reason,
    note,
    toStatus,
  });

  return NextResponse.json({ ok: true });
}
