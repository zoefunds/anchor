import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, createSession } from "@/lib/auth";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// POST /api/auth/password-reset/confirm — spend a reset token to set a new
// password, then log the member in immediately.
export async function POST(req: NextRequest) {
  const { token, password } = await req.json();
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "token is required" }, { status: 400 });
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  }

  const reset = await prisma.passwordReset.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!reset || reset.usedAt || reset.expiresAt < new Date()) {
    return NextResponse.json({ error: "reset link is invalid or expired" }, { status: 404 });
  }

  const member = await prisma.$transaction(async (tx) => {
    const updated = await tx.member.update({
      where: { id: reset.memberId },
      data: { passwordHash: hashPassword(password) },
    });
    await tx.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } });
    // Invalidate any other outstanding sessions — a reset should log out
    // whoever else might be holding a stale/compromised session.
    await tx.session.deleteMany({ where: { memberId: reset.memberId } });
    return updated;
  });

  await createSession(member.id);

  return NextResponse.json({ member: { id: member.id, email: member.email } });
}
