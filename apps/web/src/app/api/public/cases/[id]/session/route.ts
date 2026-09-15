import { NextRequest, NextResponse } from "next/server";
import { exchangePartyTokenForSession, partySessionCookieName } from "@/lib/party-auth";

// POST /api/public/cases/:id/session — exchanges a raw, still-valid party
// token for a short-lived HttpOnly session cookie (see
// lib/party-auth.ts's exchangePartyTokenForSession). This is the fix for
// "party tokens are long-lived bearer URLs in query parameters": a raw
// token should only ever need to be typed/pasted/clicked once, right
// after which the client calls this route and then uses the cookie for
// everything else — the token itself never needs to be resent, so it
// stops accumulating in browser history, referrer headers, and access
// logs on every subsequent request.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { token } = await req.json().catch(() => ({ token: undefined }));
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "token is required" }, { status: 401 });
  }

  const exchanged = await exchangePartyTokenForSession(token);
  if (!exchanged || exchanged.caseId !== (await params).id) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  const res = NextResponse.json({ role: exchanged.role, expiresAt: exchanged.expiresAt });
  res.cookies.set(partySessionCookieName(exchanged.caseId, exchanged.role), exchanged.cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: exchanged.expiresAt,
  });
  return res;
}
