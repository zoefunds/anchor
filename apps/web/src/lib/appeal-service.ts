import { NextResponse } from "next/server";
import type { Case, Decision } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { enqueueJob, ensureJobWorker } from "@/lib/jobs";
import { logAction } from "@/lib/audit";
import { escalateForAppeal } from "@/lib/escalation";

interface AuditParams {
  organizationId: string;
  memberId?: string | null;
  apiKeyId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Shared core of "contest a decision within its appeal window" — used by
 * both the org-authenticated route (api/cases/:id/appeal) and the party-
 * token route (api/public/cases/:id/appeal), so the atomic-transition and
 * job-enqueue logic exists exactly once. Returns an error NextResponse to
 * return as-is, or null on success (caller builds its own success
 * response, since the two routes' response shapes differ).
 *
 * The case transition AND its audit-log entry now commit in one
 * transaction (`audit` params passed in since the two callers' logAction
 * fields — memberId/apiKeyId vs. byParty — differ) — a case that
 * genuinely transitioned to RE_ADJUDICATING always has a matching audit
 * row, not "transitioned, but the audit write failed separately."
 * enqueueJob/webhooks stay OUTSIDE the transaction and only run after it
 * commits — they're not transactional with Postgres regardless, and a
 * job for a transition that got rolled back would be worse than one
 * that's simply late.
 */
export async function triggerAppeal(
  kase: Case,
  latestDecision: Decision | undefined,
  reason: string | undefined,
  audit: AuditParams
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
  const claimed = await prisma.$transaction(async (tx) => {
    const result = await tx.case.updateMany({
      where: { id: kase.id, status: "APPEAL_WINDOW" },
      data: { status: "RE_ADJUDICATING" },
    });
    if (result.count > 0) {
      await logAction(
        {
          organizationId: audit.organizationId,
          memberId: audit.memberId,
          apiKeyId: audit.apiKeyId,
          action: "case.appealed",
          targetType: "case",
          targetId: kase.id,
          metadata: audit.metadata,
        },
        tx
      );
    }
    return result;
  });
  if (claimed.count === 0) {
    return NextResponse.json({ error: `cannot appeal a case in status ${kase.status}` }, { status: 409 });
  }
  await enqueueJob("adjudicate_case", { caseId: kase.id, isAppeal: true });

  // Track 5, item 5 — an appeal being filed is itself a deterministic
  // human-escalation trigger: a party contesting a decision is exactly
  // the kind of signal that should get a human's eyes before the
  // re-adjudication's own outcome is trusted, independent of amount or
  // risk score. Outside the transaction above deliberately, same
  // reasoning as maybeEscalateCase's call site in api/cases/route.ts —
  // a failure here shouldn't roll back a genuinely-claimed appeal.
  await escalateForAppeal(kase.id);

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
