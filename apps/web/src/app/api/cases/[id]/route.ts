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
    include: { evidence: true, decision: true },
  });

  // Same 404 whether the case doesn't exist or belongs to another org —
  // don't leak which case IDs exist to callers outside the org.
  if (!kase || kase.organizationId !== auth.organizationId) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }
  return NextResponse.json(kase);
}
