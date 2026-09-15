import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncCase, type SyncCaseStep } from "@/lib/adjudication-service";
import { resolvePartyAuth, readPartySessionCookie } from "@/lib/party-auth";

// POST /api/public/cases/:id/sync — the party-facing equivalent of
// /api/cases/:id/sync. A claimant or respondent stuck waiting on the
// worker's own periodic sweeps (up to 10 minutes for settlement retry)
// has no way to nudge it themselves today, and no org staff member to
// ask — this lets either party force the exact same on-demand check the
// org's dashboard already has. syncCase itself is caseId-scoped only
// (no organizationId check, no org-internal data in its `actions`
// strings — see its own doc comment: "harmless no-op" when there's
// nothing to do, "always safe to call again"), so gating this purely on
// party auth (not org auth) is the same trust boundary every other
// /api/public/cases/:id/* route already uses.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { token } = await req.json().catch(() => ({ token: undefined }));
  const caseId = (await params).id;

  const sessionCookie = readPartySessionCookie(req.cookies, caseId);
  const resolved = await resolvePartyAuth(sessionCookie, typeof token === "string" ? token : undefined, caseId);
  if (!resolved) {
    return NextResponse.json({ error: "invalid token or session" }, { status: 401 });
  }

  const kase = await prisma.case.findUnique({ where: { id: caseId } });
  if (!kase) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  // Deliberately always "all" — a party has no use for the admin
  // dashboard's step-specific buttons (those exist for staff diagnosing
  // exactly where a stuck case is), just "check everything now."
  const step: SyncCaseStep = "all";
  const result = await syncCase(caseId, step);
  return NextResponse.json(result);
}
