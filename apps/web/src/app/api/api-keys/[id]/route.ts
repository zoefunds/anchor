import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { logAction } from "@/lib/audit";

// OWNER-only, same real P0 fix as ../route.ts — revocation is a
// privileged action too (a non-owner revoking a key isn't the escalation
// itself, but it's still org-management the VIEWER/MEMBER roles
// shouldn't have, and consistency here avoids a second inconsistent gate).
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const key = await prisma.apiKey.findUnique({ where: { id: params.id } });
  if (!key || key.organizationId !== member.organizationId) {
    return NextResponse.json({ error: "key not found" }, { status: 404 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    await logAction(
      {
        organizationId: member.organizationId,
        memberId: member.memberId,
        action: "api_key.revoked",
        targetType: "apiKey",
        targetId: key.id,
      },
      tx
    );
  });
  return NextResponse.json({ ok: true });
}
