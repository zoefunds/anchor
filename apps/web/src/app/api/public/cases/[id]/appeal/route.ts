import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePartyToken } from "@/lib/party-auth";
import { triggerAppeal } from "@/lib/appeal-service";
import { logAction } from "@/lib/audit";

// POST /api/public/cases/:id/appeal — either party (authenticated by
// their own per-case token, not an org session/API key — see
// lib/party-auth.ts) can independently contest a decision within its
// appeal window, without going through the org that filed the case.
// Body: { token, reason? }. Shares the exact same atomic-transition and
// contract-appeal logic as the org-authenticated
// /api/cases/:id/appeal — see lib/appeal-service.ts.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { token, reason } = await req.json().catch(() => ({ token: undefined, reason: undefined }));
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "token is required" }, { status: 401 });
  }

  const resolved = await resolvePartyToken(token);
  if (!resolved || resolved.caseId !== params.id) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  const kase = await prisma.case.findUnique({
    where: { id: resolved.caseId },
    include: { decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!kase) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const reasonStr = typeof reason === "string" ? reason : undefined;
  const errorResponse = await triggerAppeal(kase, kase.decisions[0], reasonStr);
  if (errorResponse) return errorResponse;

  logAction({
    organizationId: kase.organizationId,
    action: "case.appealed",
    targetType: "case",
    targetId: kase.id,
    metadata: { reason: reasonStr, byParty: resolved.role },
  });

  return NextResponse.json(
    { note: "Appeal accepted. Re-adjudication started. Poll GET /api/public/cases/:id for status/decision." },
    { status: 202 }
  );
}
