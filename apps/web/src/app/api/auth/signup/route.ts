import { randomBytes, createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, createSession } from "@/lib/auth";
import { sendVerificationEmail } from "@/lib/email";
import { secureAppOrigin } from "@/lib/app-env";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// POST /api/auth/signup — creates a new Organization + its founding
// (OWNER-role) Member, then a session. Every subsequent member joins via
// the invite flow (src/app/api/invites), arriving as MEMBER role.
export async function POST(req: NextRequest) {
  // Real P1 fixed here (external audit finding): secureAppOrigin() used
  // to only be called deep inside a fire-and-forget .then() callback,
  // AFTER the organization/member/session were already created — a
  // misconfigured APP_ORIGIN in production would throw there, get
  // silently swallowed by the existing .catch(), and only show up as a
  // log line while signup otherwise "succeeded" with no way to ever
  // verify that email. Called here, first, before any state is written,
  // so a misconfigured deployment fails loudly and immediately instead.
  const appOrigin = secureAppOrigin(req.nextUrl.origin);

  const { organizationName, email, password } = await req.json();

  if (!organizationName || !email || !password) {
    return NextResponse.json(
      { error: "organizationName, email, and password are required" },
      { status: 400 }
    );
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  }

  const existing = await prisma.member.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "email already registered" }, { status: 409 });
  }

  const organization = await prisma.organization.create({ data: { name: organizationName } });
  const member = await prisma.member.create({
    data: {
      organizationId: organization.id,
      email,
      passwordHash: hashPassword(password),
      role: "OWNER",
    },
  });

  await createSession(member.id);

  // Signup succeeds regardless of email deliverability — the dashboard
  // shows an unverified banner with a resend option either way. The send
  // itself must still be awaited: in serverless runtimes, detached work
  // scheduled after the response can be terminated before the Brevo request
  // actually leaves the process.
  const rawToken = randomBytes(32).toString("hex");
  await prisma.emailVerification.create({
    data: { memberId: member.id, tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
  });

  const verifyUrl = `${appOrigin}/verify-email/${rawToken}`;
  let emailError: string | null = null;
  try {
    await sendVerificationEmail({ to: email, verifyUrl });
  } catch (err) {
    emailError = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("signup verification email failed:", emailError);
  }

  return NextResponse.json(
    {
      organization: { id: organization.id, name: organization.name },
      member: { id: member.id, email: member.email },
      ...(emailError ? { verifyUrl, emailError } : {}),
    },
    { status: 201 }
  );
}
