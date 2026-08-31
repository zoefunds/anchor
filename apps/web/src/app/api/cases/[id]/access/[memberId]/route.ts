import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { logAction } from "@/lib/audit";

// PUT /api/cases/:id/access/:memberId — grant that member access to this
// (usually restricted) case. Idempotent: granting an already-granted
// member is a no-op, not an error, since retries shouldn't fail.
export async function PUT(_req: NextRequest, { params }: { params: { id: string; memberId: string } }) {
  const owner = await requireOwner();
  if ("error" in owner) {
    return NextResponse.json({ error: owner.error }, { status: owner.error === "forbidden" ? 403 : 401 });
  }

  const kase = await prisma.case.findUnique({ where: { id: params.id } });
  if (!kase || kase.organizationId !== owner.organizationId) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  const target = await prisma.member.findUnique({ where: { id: params.memberId } });
  if (!target || target.organizationId !== owner.organizationId) {
    return NextResponse.json({ error: "member not found" }, { status: 404 });
  }

  await prisma.caseAccess.upsert({
    where: { caseId_memberId: { caseId: kase.id, memberId: target.id } },
    create: { caseId: kase.id, memberId: target.id },
    update: {},
  });

  await logAction({
    organizationId: owner.organizationId,
    memberId: owner.memberId,
    action: "case.access_granted",
    targetType: "case",
    targetId: kase.id,
    metadata: { grantedToMemberId: target.id, grantedToEmail: target.email },
  });

  return NextResponse.json({ ok: true });
}

// DELETE /api/cases/:id/access/:memberId — revoke that member's access
// grant. Revoking a member who was never granted access is a no-op, not
// an error.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string; memberId: string } }) {
  const owner = await requireOwner();
  if ("error" in owner) {
    return NextResponse.json({ error: owner.error }, { status: owner.error === "forbidden" ? 403 : 401 });
  }

  const kase = await prisma.case.findUnique({ where: { id: params.id } });
  if (!kase || kase.organizationId !== owner.organizationId) {
    return NextResponse.json({ error: "case not found" }, { status: 404 });
  }

  await prisma.caseAccess.deleteMany({ where: { caseId: kase.id, memberId: params.memberId } });

  await logAction({
    organizationId: owner.organizationId,
    memberId: owner.memberId,
    action: "case.access_revoked",
    targetType: "case",
    targetId: kase.id,
    metadata: { revokedMemberId: params.memberId },
  });

  return NextResponse.json({ ok: true });
}
