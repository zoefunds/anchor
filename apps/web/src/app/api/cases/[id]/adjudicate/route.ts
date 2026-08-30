import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requiredEvidenceTypesFor, runAdjudicationJob } from "@/lib/adjudication-service";
import { resolveOrgFromRequest, authErrorResponse } from "@/lib/auth";

// POST /api/cases/:id/adjudicate — the Adjudication Builder step: validate
// evidence completeness against the policy, then hand off to GenLayer in
// the background and return immediately.
//
// Real consensus takes ~1-2 minutes (see genlayer/README.md's integration
// test timings), so this route no longer blocks the request on it — it
// transitions the case to ADJUDICATING and returns 202, and the case's
// status/decision are picked up by polling GET /api/cases/:id.
//
// Caveat: `runAdjudicationJob` here is a fire-and-forget promise within
// the same Node process, not a real job queue — it only survives as long
// as this server process stays alive, which is fine for `next dev`/a
// long-lived `next start` server but WILL be killed mid-flight on
// serverless platforms (Vercel functions, etc.) that terminate the
// process once the response is sent. Move this to a real queue (BullMQ,
// SQS, etc.) before deploying anywhere serverless — see the Worker/Case
// Service split in the root README's architecture notes.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
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

  // Deliberately not awaited — see the module-level comment above.
  void runAdjudicationJob(kase.id);

  return NextResponse.json(
    {
      case: updated,
      note: "Adjudication started. Poll GET /api/cases/:id for status/decision.",
    },
    { status: 202 }
  );
}
