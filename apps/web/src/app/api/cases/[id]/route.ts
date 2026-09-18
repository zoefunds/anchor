import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireScope } from "@/lib/auth";
import { canAccessCase } from "@/lib/case-access";
import { resolveEvidenceUri } from "@/lib/storage";

// A dashboard page load only needs the URL to survive long enough to
// render (and for the viewer to click it) — not to sit around
// indefinitely as a standing credential the way the old permanently-
// public URLs did. See lib/storage.ts's resolveEvidenceUri.
const DASHBOARD_EVIDENCE_URL_TTL_SECONDS = 10 * 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }
  const scopeError = requireScope(auth, "cases:read");
  if (scopeError) return scopeError;

  const kase = await prisma.case.findUnique({
    where: { id: (await params).id },
    include: { evidence: true, decisions: { orderBy: { createdAt: "desc" } } },
  });

  // Same 404 whether the case doesn't exist, belongs to another org, or
  // is restricted and this caller isn't granted access — don't leak which
  // case IDs exist (or that a restricted one exists) to callers who can't
  // see it.
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const latestDecision = kase.decisions[0] ?? null;
  const canAppeal =
    kase.status === "APPEAL_WINDOW" &&
    Boolean(latestDecision?.appealWindowClosesAt) &&
    latestDecision!.appealWindowClosesAt! > new Date();

  return NextResponse.json({
    ...kase,
    evidence: kase.evidence.map((e) => ({
      ...e,
      storageRef: resolveEvidenceUri(e.storageRef, DASHBOARD_EVIDENCE_URL_TTL_SECONDS, e.mimeType),
    })),
    // Back-compat single-decision field the dashboard already reads —
    // always the most recent of the case's decision history.
    decision: latestDecision,
    canAppeal,
  });
}
