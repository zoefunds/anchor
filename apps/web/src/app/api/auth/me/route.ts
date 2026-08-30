import { NextResponse } from "next/server";
import { getSessionMember } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const member = await getSessionMember();
  if (!member) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const organization = await prisma.organization.findUnique({ where: { id: member.organizationId } });
  return NextResponse.json({ member: { id: member.memberId, email: member.email }, organization });
}
