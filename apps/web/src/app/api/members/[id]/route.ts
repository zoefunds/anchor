import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { logAction } from "@/lib/audit";

// DELETE /api/members/:id — remove a member from the org. OWNER-only; an
// owner can't remove themselves this way (there'd be no owner left) — an
// org must always have at least one OWNER, so ownership transfer would
// need its own explicit flow, which doesn't exist yet.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const target = await prisma.member.findUnique({ where: { id: params.id } });
  if (!target || target.organizationId !== member.organizationId) {
    return NextResponse.json({ error: "member not found" }, { status: 404 });
  }
  if (target.id === member.memberId) {
    return NextResponse.json({ error: "cannot remove yourself as the org's owner" }, { status: 400 });
  }

  await prisma.$transaction([
    prisma.session.deleteMany({ where: { memberId: target.id } }),
    prisma.member.delete({ where: { id: target.id } }),
  ]);

  await logAction({
    organizationId: member.organizationId,
    memberId: member.memberId,
    action: "member.removed",
    targetType: "member",
    targetId: target.id,
    metadata: { email: target.email },
  });

  return NextResponse.json({ ok: true });
}
