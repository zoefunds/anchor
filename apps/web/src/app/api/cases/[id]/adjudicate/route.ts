import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requiredEvidenceTypesFor } from "@/lib/adjudication-service";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess, requireScope } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { enqueueJob, ensureJobWorker } from "@/lib/jobs";
import { canAccessCase } from "@/lib/case-access";

// POST /api/cases/:id/adjudicate — the Adjudication Builder step: validate
// evidence completeness against the policy, then hand off to GenLayer via
// the Job queue and return immediately.
//
// Real consensus takes ~1-2 minutes (see genlayer/README.md's integration
// test timings), so this route doesn't block on it — it transitions the
// case to ADJUDICATING and returns 202; status/decision are picked up by
// polling GET /api/cases/:id, or by a subscribed webhook.
//
// The actual run is a BullMQ job (src/lib/queue.ts + src/lib/worker.ts),
// not a bare fire-and-forget promise — durable on Redis, with real
// exponential backoff between retries. ensureJobWorker() below starts
// this server's in-process worker (a no-op once a standalone worker is
// running — see src/worker.ts); either can pick this job up.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  ensureJobWorker();

  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }
  const writeError = requireWriteAccess(auth);
  if (writeError) return writeError;
  const scopeError = requireScope(auth, "cases:write");
  if (scopeError) return scopeError;

  const kase = await prisma.case.findUnique({
    where: { id: (await params).id },
    include: { evidence: true },
  });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
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

  // Atomic, conditional transition — only succeeds if the case is still
  // exactly EVIDENCE_COLLECTION, so two concurrent adjudicate requests
  // for the same case can't both pass the status check above and both
  // enqueue a job (which would deploy two GenLayer contracts for one
  // case, or race two adjudicate() calls against each other). The
  // now-unused SUBMITTED status this used to pass through was never read
  // anywhere else, so going straight to ADJUDICATING loses nothing. The
  // transition and its audit entry commit together — enqueueJob stays
  // outside the transaction (not transactional with Postgres regardless)
  // and only runs after a real commit, so a rolled-back transition can
  // never still enqueue a job for it.
  const claimed = await prisma.$transaction(async (tx) => {
    const result = await tx.case.updateMany({
      where: { id: kase.id, status: "EVIDENCE_COLLECTION" },
      data: { status: "ADJUDICATING" },
    });
    if (result.count > 0) {
      await logAction(
        {
          organizationId: auth.organizationId,
          memberId: auth.memberId,
          apiKeyId: auth.apiKeyId,
          action: "case.adjudicate_requested",
          targetType: "case",
          targetId: kase.id,
        },
        tx
      );
    }
    return result;
  });
  if (claimed.count === 0) {
    return NextResponse.json(
      { error: `cannot submit for adjudication in status ${kase.status}` },
      { status: 409 }
    );
  }
  const updated = await prisma.case.findUniqueOrThrow({ where: { id: kase.id } });

  await enqueueJob("adjudicate_case", { caseId: kase.id, isAppeal: false });

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
