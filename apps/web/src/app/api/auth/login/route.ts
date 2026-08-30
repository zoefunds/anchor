import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPassword, createSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { email, password } = await req.json();
  if (!email || !password) {
    return NextResponse.json({ error: "email and password are required" }, { status: 400 });
  }

  const member = await prisma.member.findUnique({ where: { email } });
  // Constant-shape response whether the email exists or not — don't leak
  // account existence via a different error message.
  if (!member || !verifyPassword(password, member.passwordHash)) {
    return NextResponse.json({ error: "invalid email or password" }, { status: 401 });
  }

  await createSession(member.id);

  return NextResponse.json({ member: { id: member.id, email: member.email } });
}
