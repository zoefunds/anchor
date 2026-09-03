import { randomBytes, createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionMember } from "@/lib/auth";
import { sendVerificationEmail } from "@/lib/email";
import { secureAppOrigin } from "@/lib/app-env";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function appOrigin(req: NextRequest): string {
  return secureAppOrigin(req.nextUrl.origin);
}

// POST /api/auth/verify-email — send (or resend) a verification link to
// the logged-in member's own email.
export async function POST(req: NextRequest) {
  const member = await getSessionMember();
  if (!member) {
    return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }
  if (member.role === "OWNER") {
    const current = await prisma.member.findUnique({ where: { id: member.memberId } });
    if (current?.emailVerifiedAt) {
      return NextResponse.json({ ok: true, alreadyVerified: true });
    }
  }

  const rawToken = randomBytes(32).toString("hex");
  await prisma.emailVerification.create({
    data: {
      memberId: member.memberId,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
    },
  });

  const verifyUrl = `${appOrigin(req)}/verify-email/${rawToken}`;
  try {
    await sendVerificationEmail({ to: member.email, verifyUrl });
  } catch (err) {
    return NextResponse.json(
      { ok: true, verifyUrl, emailError: err instanceof Error ? err.message : String(err) },
      { status: 201 }
    );
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
