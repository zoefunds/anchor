import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncCase } from "@/lib/adjudication-service";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess, requireScope } from "@/lib/auth";
import { canAccessCase } from "@/lib/case-access";

// POST /api/cases/:id/sync — on-demand version of the worker's periodic
// sweeps (deposit confirmation, appeal-window finalization, settlement
// retry), scoped to this one case. The sweeps themselves keep running
// unchanged on their own schedule — this exists purely so staff can force
// an immediate check instead of waiting out an interval (up to 10 minutes
// for settlement retry), not as a replacement for them. See
// adjudication-service.ts's syncCase for what each step actually does
// and why it's always safe to call again.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) {
    return authErrorResponse(auth);
  }
  const writeError = requireWriteAccess(auth);
  if (writeError) return writeError;
  const scopeError = requireScope(auth, "cases:write");
  if (scopeError) return scopeError;

  const kase = await prisma.case.findUnique({ where: { id: params.id } });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const result = await syncCase(params.id);
  return NextResponse.json(result);
}
