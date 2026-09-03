import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePartyAuth, PARTY_SESSION_COOKIE } from "@/lib/party-auth";
import { createDiditSession } from "@/lib/didit";
import { secureAppOrigin } from "@/lib/app-env";

// POST /api/public/cases/:id/verification — a party (claimant or
// respondent, authenticated the same way as evidence submission — see
// api/public/cases/:id/evidence/route.ts) starts a real Didit KYC
// session for themselves. Returns the hosted verification URL to
// redirect the party to; Didit collects ID/liveness/face-match on
// their own domain, then calls back both via redirect (callback below)
// and via webhook (api/webhooks/didit/route.ts) with the actual
// result — this route only ever creates the session, it never
// receives or trusts a decision directly from the client.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { token } = await req.json().catch(() => ({}));

  const sessionCookie = req.cookies.get(PARTY_SESSION_COOKIE)?.value;
  const resolved = await resolvePartyAuth(sessionCookie, typeof token === "string" ? token : undefined, params.id);
  if (!resolved) {
    return NextResponse.json({ error: "invalid token or session" }, { status: 401 });
  }

  const kase = await prisma.case.findUnique({ where: { id: params.id } });
  if (!kase) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  // One verification per (case, role) — reuse an existing in-flight or
  // completed session rather than minting a fresh one every time the
  // party reloads the page; Didit's own session-creation is also
  // idempotent on vendor_data for unfinished sessions, but keeping our
  // own PartyVerification row authoritative here avoids depending on
  // that behavior.
  const existing = await prisma.partyVerification.findUnique({
    where: { caseId_role: { caseId: kase.id, role: resolved.role } },
  });
  if (existing && existing.status !== "NOT_STARTED") {
    return NextResponse.json({ status: existing.status, sessionId: existing.sessionId });
  }

  const appOrigin = secureAppOrigin(req.nextUrl.origin);
  // vendor_data carries our own PartyVerification id (created below, or
  // reused if a NOT_STARTED row already exists) so the webhook handler
  // can look the row up directly without a separate case+role query —
  // see api/webhooks/didit/route.ts.
  const verificationId = existing?.id ?? (await prisma.partyVerification.create({
    data: { caseId: kase.id, role: resolved.role, sessionId: `pending-${crypto.randomUUID()}`, status: "NOT_STARTED" },
  })).id;

  let session;
  try {
    session = await createDiditSession({
      vendorData: verificationId,
      callbackUrl: `${appOrigin}/public/cases/${kase.id}/verification-complete`,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  await prisma.partyVerification.update({
    where: { id: verificationId },
    data: { sessionId: session.session_id, status: "IN_PROGRESS" },
  });

  return NextResponse.json({ url: session.url, sessionId: session.session_id, status: "IN_PROGRESS" });
}

// GET /api/public/cases/:id/verification — current status for this
// party, for the "Verify your identity" page to poll as a fallback
// when the webhook hasn't landed yet (or the party never left/returned
// from the hosted flow in the same browser session).
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.nextUrl.searchParams.get("token") ?? undefined;
  const sessionCookie = req.cookies.get(PARTY_SESSION_COOKIE)?.value;
  const resolved = await resolvePartyAuth(sessionCookie, token, params.id);
  if (!resolved) {
    return NextResponse.json({ error: "invalid token or session" }, { status: 401 });
  }

  const existing = await prisma.partyVerification.findUnique({
    where: { caseId_role: { caseId: params.id, role: resolved.role } },
    select: { status: true, sessionId: true, updatedAt: true },
  });
  return NextResponse.json(existing ?? { status: "NOT_STARTED", sessionId: null });
}
