import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { logAction } from "@/lib/audit";

// GET /api/cases/:id/access — current restriction state + the list of
// members explicitly granted access. OWNER-only, same as managing members
// themselves — restricting a case is an access-control decision, not
// something any member should be able to do to hide a case from peers.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const kase = await prisma.case.findUnique({
    where: { id: params.id },
    include: { caseAccess: { include: { member: { select: { id: true, email: true } } } } },
  });
  if (!kase || kase.organizationId !== member.organizationId) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  return NextResponse.json({
    restricted: kase.restricted,
    grantedMembers: kase.caseAccess.map((a) => a.member),
  });
}

// PATCH /api/cases/:id/access — body { restricted: boolean }. Toggling
// this on doesn't wipe the CaseAccess allow-list off (so re-enabling
// later restores the same grants), it just starts/stops enforcing it.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const { restricted } = await req.json();
  if (typeof restricted !== "boolean") {
    return NextResponse.json({ error: "restricted (boolean) is required" }, { status: 400 });
  }

  const kase = await prisma.case.findUnique({ where: { id: params.id } });
  if (!kase || kase.organizationId !== member.organizationId) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.case.update({ where: { id: kase.id }, data: { restricted } });
    await logAction(
      {
        organizationId: member.organizationId,
        memberId: member.memberId,
        action: restricted ? "case.restricted" : "case.unrestricted",
        targetType: "case",
        targetId: kase.id,
      },
      tx
    );
    return result;
  });

  return NextResponse.json({ restricted: updated.restricted });
}
