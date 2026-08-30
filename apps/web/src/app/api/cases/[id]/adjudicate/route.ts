import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requiredEvidenceTypesFor } from "@/lib/adjudication-service";
import { resolveOrgFromRequest, authErrorResponse } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { enqueueJob, ensureJobPoller } from "@/lib/jobs";

// POST /api/cases/:id/adjudicate — the Adjudication Builder step: validate
// evidence completeness against the policy, then hand off to GenLayer via
// the Job queue and return immediately.
//
// Real consensus takes ~1-2 minutes (see genlayer/README.md's integration
// test timings), so this route doesn't block on it — it transitions the
// case to ADJUDICATING and returns 202; status/decision are picked up by
// polling GET /api/cases/:id, or by a subscribed webhook.
//
// The actual run is a DB-backed Job row (src/lib/jobs.ts), not a bare
// fire-and-forget promise — its state survives this process restarting.
// It's still processed by an in-process poller in this same server,
// though, not a separate worker; see the Job model's schema comment for
// what that does and doesn't buy on serverless.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  ensureJobPoller();

  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }

  const kase = await prisma.case.findUnique({
    where: { id: params.id },
    include: { evidence: true },
  });
  if (!kase || kase.organizationId !== auth.organizationId) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }
  if (kase.status !== "EVIDENCE_COLLECTION") {
    return NextResponse.json(
      { error: `cannot submit for adjudication in status ${kase.status}` },
      { status: 409 }
    );
  }

  const presentTypes = new Set(kase.evidence.map((e) => e.type));
  const missing = requiredEvidenceTypesFor(kase.policyId).filter((t) => !presentTypes.has(t));
  if (missing.length > 0) {
    return NextResponse.json({ error: "missing required evidence", missing }, { status: 400 });
  }

  await prisma.case.update({ where: { id: kase.id }, data: { status: "SUBMITTED" } });
  const updated = await prisma.case.update({
    where: { id: kase.id },
    data: { status: "ADJUDICATING" },
  });

  await enqueueJob("adjudicate_case", { caseId: kase.id, isAppeal: false });

  logAction({
    organizationId: auth.organizationId,
    memberId: auth.memberId,
    apiKeyId: auth.apiKeyId,
    action: "case.adjudicate_requested",
    targetType: "case",
    targetId: kase.id,
  });
  dispatchWebhookEvent({
    organizationId: auth.organizationId,
    event: "case.status_changed",
    data: { caseId: kase.id, status: "ADJUDICATING" },
  });

  return NextResponse.json(
    {
      case: updated,
      note: "Adjudication started. Poll GET /api/cases/:id for status/decision.",
    },
    { status: 202 }
  );
}
