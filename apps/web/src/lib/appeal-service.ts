import { NextResponse } from "next/server";
import type { Case, Decision } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { enqueueJob, ensureJobWorker } from "@/lib/jobs";

/**
 * Shared core of "contest a decision within its appeal window" — used by
 * both the org-authenticated route (api/cases/:id/appeal) and the party-
 * token route (api/public/cases/:id/appeal), so the atomic-transition and
 * job-enqueue logic exists exactly once. Returns an error NextResponse to
 * return as-is, or null on success (caller builds its own success
 * response, since the two routes' response shapes/logAction calls differ).
 */
export async function triggerAppeal(
  kase: Case,
  latestDecision: Decision | undefined,
  reason: string | undefined
): Promise<NextResponse | null> {
  ensureJobWorker();

  if (kase.status !== "APPEAL_WINDOW") {
    return NextResponse.json({ error: `cannot appeal a case in status ${kase.status}` }, { status: 409 });
  }
  if (!kase.contractAddress) {
    return NextResponse.json({ error: "case has no deployed contract" }, { status: 500 });
  }
  if (!latestDecision?.appealWindowClosesAt || latestDecision.appealWindowClosesAt < new Date()) {
    return NextResponse.json({ error: "appeal window has closed" }, { status: 409 });
  }

  // Atomic, conditional transition — only succeeds if the case is still
  // exactly APPEAL_WINDOW, so two concurrent appeal requests for the same
  // case (from either route) can't both pass the checks above and both
  // enqueue an appeal job.
  const claimed = await prisma.case.updateMany({
    where: { id: kase.id, status: "APPEAL_WINDOW" },
    data: { status: "RE_ADJUDICATING" },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ error: `cannot appeal a case in status ${kase.status}` }, { status: 409 });
  }
  await enqueueJob("adjudicate_case", { caseId: kase.id, isAppeal: true });

  dispatchWebhookEvent({
    organizationId: kase.organizationId,
    event: "case.appealed",
    data: { caseId: kase.id, reason },
  });
  dispatchWebhookEvent({
    organizationId: kase.organizationId,
    event: "case.status_changed",
    data: { caseId: kase.id, status: "RE_ADJUDICATING" },
  });

  return null;
}
