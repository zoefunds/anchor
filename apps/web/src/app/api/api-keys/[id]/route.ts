import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionMember } from "@/lib/auth";

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const member = await getSessionMember();
  if (!member) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const key = await prisma.apiKey.findUnique({ where: { id: params.id } });
  if (!key || key.organizationId !== member.organizationId) {
    return NextResponse.json({ error: "key not found" }, { status: 404 });
  }

  await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
  return NextResponse.json({ ok: true });
}
