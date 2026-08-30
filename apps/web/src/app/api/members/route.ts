import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionMember } from "@/lib/auth";

// GET /api/members — list this org's members. Any member can see the
// roster; only OWNER can remove someone (see [id]/route.ts).
export async function GET() {
  const member = await getSessionMember();
  if (!member) {
    return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }

  const members = await prisma.member.findMany({
    where: { organizationId: member.organizationId },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, role: true, emailVerifiedAt: true, createdAt: true },
  });
  return NextResponse.json(members);
}
