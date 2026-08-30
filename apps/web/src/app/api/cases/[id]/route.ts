import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse } from "@/lib/auth";

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }

  const kase = await prisma.case.findUnique({
    where: { id: params.id },
    include: { evidence: true, decisions: { orderBy: { createdAt: "desc" } } },
  });

  // Same 404 whether the case doesn't exist or belongs to another org —
  // don't leak which case IDs exist to callers outside the org.
  if (!kase || kase.organizationId !== auth.organizationId) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const latestDecision = kase.decisions[0] ?? null;
  const canAppeal =
    kase.status === "APPEAL_WINDOW" &&
    Boolean(latestDecision?.appealWindowClosesAt) &&
    latestDecision!.appealWindowClosesAt! > new Date();

  return NextResponse.json({
    ...kase,
    // Back-compat single-decision field the dashboard already reads —
    // always the most recent of the case's decision history.
    decision: latestDecision,
    canAppeal,
  });
}
