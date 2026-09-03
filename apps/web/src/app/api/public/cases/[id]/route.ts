import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePartyAuth, PARTY_SESSION_COOKIE } from "@/lib/party-auth";
import { resolveEvidenceUri } from "@/lib/storage";

const PUBLIC_EVIDENCE_URL_TTL_SECONDS = 10 * 60;

// GET /api/public/cases/:id?token=... — for the counterparty in a
// dispute who doesn't hold an org session or API key but still needs to
// see the case's evidence and verdict. Requires a valid per-case party
// token or an exchanged session cookie (see lib/party-auth.ts) — a bare
// case ID is not a credential, and evidence/statements are exactly the
// kind of thing that must not be readable by anyone who merely learns
// the ID (forwarded link, referrer leak, log line, etc).
//
// Deliberately a narrow field set, not `prisma.case` wholesale: no
// organizationId, no internal contractAddress-adjacent org context, and
// evidence storageRef is still exposed (it's either the literal
// submitted text, or — for a file — a freshly signed, short-lived
// Cloudinary URL resolved just for this response, not a standing
// public link — see lib/storage.ts's resolveEvidenceUri) but nothing
// about which org filed it or its API keys/members/billing.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.nextUrl.searchParams.get("token") ?? undefined;
  const sessionCookie = req.cookies.get(PARTY_SESSION_COOKIE)?.value;
  const resolved = await resolvePartyAuth(sessionCookie, token, params.id);
  if (!resolved) {
    return NextResponse.json({ error: "token query parameter or session is required" }, { status: 401 });
  }

  const kase = await prisma.case.findUnique({
    where: { id: params.id },
    include: {
      evidence: { orderBy: { createdAt: "asc" } },
      decisions: { orderBy: { createdAt: "desc" } },
      settlement: { include: { integration: true } },
    },
  });
  if (!kase) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: kase.id,
    status: kase.status,
    claim: kase.claim,
    amount: kase.amount,
    currency: kase.currency,
    policyId: kase.policyId,
    claimantRef: kase.claimantRef,
    respondentRef: kase.respondentRef,
    createdAt: kase.createdAt,
    // The resolving party's own role — lets the page render "set YOUR
    // payout address" without a second round trip, and without ever
    // exposing which role a caller resolved to anyone who didn't
    // already prove it via their own token/session.
    role: resolved.role,
    settlement: kase.settlement
      ? {
          status: kase.settlement.status,
          chain: kase.settlement.integration.chain,
          assetSymbol: kase.settlement.integration.assetSymbol,
          expectedAmountAtto: kase.settlement.expectedAmountAtto,
          claimantAddress: kase.settlement.claimantAddress,
          respondentAddress: kase.settlement.respondentAddress,
        }
      : null,
    evidence: kase.evidence.map((e) => ({
      id: e.id,
      type: e.type,
      storageRef: resolveEvidenceUri(e.storageRef, PUBLIC_EVIDENCE_URL_TTL_SECONDS),
      mimeType: e.mimeType,
      createdAt: e.createdAt,
    })),
    decisions: kase.decisions.map((d) => ({
      outcome: d.outcome,
      claimantShareBps: d.claimantShareBps,
      respondentShareBps: d.respondentShareBps,
      reasonCodes: d.reasonCodes,
      consensus: d.consensus,
      appealWindowClosesAt: d.appealWindowClosesAt,
      createdAt: d.createdAt,
    })),
  });
}
