import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveOrgFromRequest, authErrorResponse, requireWriteAccess, requireScope } from "@/lib/auth";
import { canAccessCase } from "@/lib/case-access";
import { checkAndConfirmDeposit } from "@/lib/case-settlement";

// POST /api/cases/:id/settlement/confirm-deposit — on-demand trigger
// for the same real on-chain check the worker sweep runs
// periodically (see adjudication-service.ts's confirmPendingDeposits).
// Never trusts anything in the request body — the only input is which
// case's CaseSettlement to check, everything else is read live from
// the escrow contract.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await resolveOrgFromRequest(req);
  if ("error" in auth) return authErrorResponse(auth);
  const writeError = requireWriteAccess(auth);
  if (writeError) return writeError;
  const scopeError = requireScope(auth, "settlements:write");
  if (scopeError) return scopeError;

  const kase = await prisma.case.findUnique({ where: { id: params.id }, include: { settlement: true } });
  if (!kase || kase.organizationId !== auth.organizationId || !(await canAccessCase(auth, kase))) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }
  if (!kase.settlement) {
    return NextResponse.json({ error: "this case has no settlement binding yet" }, { status: 409 });
  }

  const result = await checkAndConfirmDeposit(kase.settlement.id);
  const status = result.outcome === "confirmed" || result.outcome === "already_confirmed" ? 200 : 202;
  return NextResponse.json(result, { status });
}
