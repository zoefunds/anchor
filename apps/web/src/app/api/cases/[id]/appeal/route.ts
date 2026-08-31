import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { enqueueJob, ensureJobWorker } from "@/lib/jobs";
import { canAccessCase } from "@/lib/case-access";

// POST /api/cases/:id/appeal — contest a decision within its appeal
// window and trigger exactly one re-adjudication round. The contract
// itself caps this at one appeal (see adjudicator.py's MAX_APPEALS) —
// this route's own checks (status + window) are the app-level gate that
// keeps a party from even attempting a second one, but the contract is
// the actual source of truth and will reject it on-chain regardless.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  ensureJobWorker();

  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }
  const writeError = requireWriteAccess(auth);
  if (writeError) return writeError;

  const kase = await prisma.case.findUnique({
    where: { id: params.id },
    include: { decisions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }
  if (kase.status !== "APPEAL_WINDOW") {
    return NextResponse.json({ error: `cannot appeal a case in status ${kase.status}` }, { status: 409 });
  }
  if (!kase.contractAddress) {
    return NextResponse.json({ error: "case has no deployed contract" }, { status: 500 });
  }

  const latestDecision = kase.decisions[0];
  if (!latestDecision?.appealWindowClosesAt || latestDecision.appealWindowClosesAt < new Date()) {
    return NextResponse.json({ error: "appeal window has closed" }, { status: 409 });
  }

  const { reason } = await req.json().catch(() => ({ reason: undefined }));

  await prisma.case.update({ where: { id: kase.id }, data: { status: "RE_ADJUDICATING" } });
  await enqueueJob("adjudicate_case", { caseId: kase.id, isAppeal: true });

  logAction({
    organizationId: auth.organizationId,
    memberId: auth.memberId,
    apiKeyId: auth.apiKeyId,
    action: "case.appealed",
    targetType: "case",
    targetId: kase.id,
    metadata: { reason: typeof reason === "string" ? reason : undefined },
  });
  dispatchWebhookEvent({
    organizationId: auth.organizationId,
    event: "case.appealed",
    data: { caseId: kase.id, reason: typeof reason === "string" ? reason : undefined },
  });
  dispatchWebhookEvent({
    organizationId: auth.organizationId,
    event: "case.status_changed",
    data: { caseId: kase.id, status: "RE_ADJUDICATING" },
  });

  return NextResponse.json(
    { note: "Appeal accepted. Re-adjudication started. Poll GET /api/cases/:id for status/decision." },
    { status: 202 }
  );
}
