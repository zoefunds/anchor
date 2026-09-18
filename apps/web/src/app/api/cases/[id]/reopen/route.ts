import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { canAccessCase } from "@/lib/case-access";
import { logAction } from "@/lib/audit";
import { dispatchWebhookEvent } from "@/lib/webhooks";

// POST /api/cases/:id/reopen — the recovery path for a case GenLayer
// genuinely couldn't decide. Before this route existed, UNDETERMINED was
// a dead end: /api/cases/:id/adjudicate hard-requires EVIDENCE_COLLECTION,
// so a stuck case's only way forward was the emergency-refund escape
// hatch (100% to claimant, no real second verdict — see
// emergency-refund/prepare/route.ts's own doc comment). This lets an
// OWNER send the case back to EVIDENCE_COLLECTION so it can go through a
// real adjudication attempt again — resubmitting the same evidence
// as-is, adding more first, or correcting something that made the first
// run fail.
//
// Capped at exactly one use per case (Case.reopenedFromUndeterminedAt,
// deliberately a timestamp not a counter): a case that lands on
// UNDETERMINED a SECOND time after a real re-adjudication attempt still
// has to fall back to emergency-refund rather than letting an org loop
// evidence resubmission forever chasing a favorable verdict.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOwner();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.error === "forbidden" ? 403 : 401 });
  }

  const kase = await prisma.case.findUnique({ where: { id: (await params).id } });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }
  if (kase.status !== "UNDETERMINED") {
    return NextResponse.json({ error: `cannot reopen a case in status ${kase.status}, must be UNDETERMINED` }, { status: 409 });
  }
  if (kase.reopenedFromUndeterminedAt) {
    return NextResponse.json(
      { error: `this case already used its one-time reopen (at ${kase.reopenedFromUndeterminedAt.toISOString()}) — use emergency-refund instead` },
      { status: 409 }
    );
  }

  // Atomic, conditional transition — same reasoning as adjudicate/route.ts's
  // own updateMany guard: only succeeds if the case is still exactly
  // UNDETERMINED with no prior reopen, so two concurrent reopen requests
  // can't both pass the checks above and both flip the case.
  //
  // contractAddress is cleared here — real bug found alongside this
  // route's first use: runAdjudicationJob's non-appeal branch reuses
  // kase.contractAddress whenever it's already set (checking
  // getDecision() first, to recover a decision an earlier attempt may
  // have already reached — see that function's own comment). Left
  // untouched, a reopened case's next /adjudicate call would hit that
  // exact branch, find the OLD contract already reached a real DECIDED
  // state (UNDETERMINED is a valid, real consensus outcome, not an
  // error), and simply recover the SAME stale UNDETERMINED decision
  // instead of ever genuinely re-adjudicating — silently defeating the
  // entire point of reopening. Clearing it forces the next /adjudicate
  // call down the "no contractAddress" branch, which deploys a genuinely
  // fresh contract.
  const claimed = await prisma.case.updateMany({
    where: { id: kase.id, status: "UNDETERMINED", reopenedFromUndeterminedAt: null },
    data: { status: "EVIDENCE_COLLECTION", reopenedFromUndeterminedAt: new Date(), contractAddress: null },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ error: "case was already reopened or is no longer UNDETERMINED" }, { status: 409 });
  }

  await logAction({
    organizationId: auth.organizationId,
    memberId: auth.memberId,
    action: "case.reopened_from_undetermined",
    targetType: "Case",
    targetId: kase.id,
  });

  dispatchWebhookEvent({
    organizationId: auth.organizationId,
    event: "case.status_changed",
    data: { caseId: kase.id, status: "EVIDENCE_COLLECTION", reason: "reopened_from_undetermined" },
  });

  const updated = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });
  return NextResponse.json({ case: updated });
}
