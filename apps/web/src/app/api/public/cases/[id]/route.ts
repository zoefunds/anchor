import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolvePartyToken } from "@/lib/party-auth";

// GET /api/public/cases/:id?token=... — for the counterparty in a
// dispute who doesn't hold an org session or API key but still needs to
// see the case's evidence and verdict. Requires a valid per-case party
// token (see lib/party-auth.ts) — a bare case ID is not a credential,
// and evidence/statements are exactly the kind of thing that must not
// be readable by anyone who merely learns the ID (forwarded link,
// referrer leak, log line, etc).
//
// Deliberately a narrow field set, not `prisma.case` wholesale: no
// organizationId, no internal contractAddress-adjacent org context, and
// evidence storageRef is still exposed (it's already a public URL or the
// literal submitted text — that's the whole point of showing evidence to
// the other party) but nothing about which org filed it or its API
// keys/members/billing.
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "token query parameter is required" }, { status: 401 });
  }
  const resolved = await resolvePartyToken(token);
  if (!resolved || resolved.caseId !== params.id) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  const kase = await prisma.case.findUnique({
    where: { id: params.id },
    include: {
      evidence: { orderBy: { createdAt: "asc" } },
      decisions: { orderBy: { createdAt: "desc" } },
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
    evidence: kase.evidence.map((e) => ({
      id: e.id,
      type: e.type,
      storageRef: e.storageRef,
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
