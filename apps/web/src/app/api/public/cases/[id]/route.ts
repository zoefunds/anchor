import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/public/cases/:id — no auth. For the counterparty in a dispute
// who doesn't hold an org session or API key but still needs to see the
// case's evidence and verdict — e.g. the respondent when the claimant's
// org is the one that filed the case in Anchor.
//
// Deliberately a narrow field set, not `prisma.case` wholesale: no
// organizationId, no internal contractAddress-adjacent org context, and
// evidence storageRef is still exposed (it's already a public URL or the
// literal submitted text — that's the whole point of showing evidence to
// the other party) but nothing about which org filed it or its API
// keys/members/billing.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
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
