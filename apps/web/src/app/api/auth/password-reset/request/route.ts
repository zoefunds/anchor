import { randomBytes, createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { sendPasswordResetEmail } from "@/lib/email";
import { secureAppOrigin } from "@/lib/app-env";

const RESET_TTL_MS = 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function appOrigin(req: NextRequest): string {
  return secureAppOrigin(req.nextUrl.origin);
}

// POST /api/auth/password-reset/request — always responds the same way
// regardless of whether the email matches a member, so this endpoint
// can't be used to enumerate registered emails.
export async function POST(req: NextRequest) {
  // Real P1 fixed here (external audit finding): appOrigin() used to be
  // called only after the PasswordReset row was already inserted — a
  // misconfigured APP_ORIGIN would throw AFTER that real state write,
  // leaving an unusable reset token in the DB with no way to ever build
  // its link. Called first, before any state is written.
  const resolvedAppOrigin = appOrigin(req);

  const { email } = await req.json();
  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const member = await prisma.member.findUnique({ where: { email } });
  if (member) {
    const rawToken = randomBytes(32).toString("hex");
    await prisma.passwordReset.create({
      data: {
        memberId: member.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      },
    });

    const resetUrl = `${resolvedAppOrigin}/reset-password/${rawToken}`;
    try {
      await sendPasswordResetEmail({ to: member.email, resetUrl });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("password reset email failed:", err instanceof Error ? err.message : err);
    }
  }

  return NextResponse.json({ ok: true });
}
