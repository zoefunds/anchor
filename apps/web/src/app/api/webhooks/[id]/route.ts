import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { logAction } from "@/lib/audit";

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const webhook = await prisma.webhook.findUnique({ where: { id: params.id } });
  if (!webhook || webhook.organizationId !== member.organizationId) {
    return NextResponse.json({ error: "webhook not found" }, { status: 404 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.webhook.delete({ where: { id: webhook.id } });
    await logAction(
      {
        organizationId: member.organizationId,
        memberId: member.memberId,
        action: "webhook.deleted",
        targetType: "webhook",
        targetId: webhook.id,
      },
      tx
    );
  });

  return NextResponse.json({ ok: true });
}
