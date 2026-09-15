import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// POST /api/auth/verify-email/:token — spend a verification token.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const verification = await prisma.emailVerification.findUnique({ where: { tokenHash: hashToken((await params).token) } });
  if (!verification || verification.verifiedAt || verification.expiresAt < new Date()) {
    return NextResponse.json({ error: "verification link is invalid or expired" }, { status: 404 });
  }

  await prisma.$transaction([
    prisma.emailVerification.update({ where: { id: verification.id }, data: { verifiedAt: new Date() } }),
    prisma.member.update({ where: { id: verification.memberId }, data: { emailVerifiedAt: new Date() } }),
  ]);

  return NextResponse.json({ ok: true });
}
