import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePartyAuth, readPartySessionCookie } from "@/lib/party-auth";
import { triggerAppeal } from "@/lib/appeal-service";

// POST /api/public/cases/:id/appeal — either party (authenticated by
// their own per-case token or an exchanged session cookie, not an org
// session/API key — see lib/party-auth.ts) can independently contest a
// decision within its appeal window, without going through the org that
// filed the case. Body: { token?, reason? }. Shares the exact same
// atomic-transition and contract-appeal logic as the org-authenticated
// /api/cases/:id/appeal — see lib/appeal-service.ts.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { token, reason } = await req.json().catch(() => ({ token: undefined, reason: undefined }));

  const sessionCookie = readPartySessionCookie(req.cookies, (await params).id);
  const resolved = await resolvePartyAuth(sessionCookie, typeof token === "string" ? token : undefined, (await params).id);
  if (!resolved) {
    return NextResponse.json({ error: "invalid token or session" }, { status: 401 });
  }

  const kase = await prisma.case.findUnique({
    where: { id: (await params).id },
    include: { decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!kase) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const reasonStr = typeof reason === "string" ? reason : undefined;
  const errorResponse = await triggerAppeal(kase, kase.decisions[0], reasonStr, {
    organizationId: kase.organizationId,
    metadata: { reason: reasonStr, byParty: resolved.role },
  });
  if (errorResponse) return errorResponse;

  return NextResponse.json(
    { note: "Appeal accepted. Re-adjudication started. Poll GET /api/public/cases/:id for status/decision." },
    { status: 202 }
  );
}
