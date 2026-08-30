import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, createSession } from "@/lib/auth";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// GET /api/invites/:token — resolve an invite for the accept page to
// display (org name, email) without requiring auth, and without leaking
// anything beyond what's needed to render the form.
export async function GET(_req: NextRequest, { params }: { params: { token: string } }) {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashToken(params.token) },
    include: { organization: true },
  });

  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
    return NextResponse.json({ error: "invite not found or expired" }, { status: 404 });
  }

  return NextResponse.json({
    email: invite.email,
    organizationName: invite.organization.name,
  });
}

// POST /api/invites/:token — accept an invite by setting a password,
// creating the Member, and starting a session immediately.
export async function POST(req: NextRequest, { params }: { params: { token: string } }) {
  const { password } = await req.json();
  if (!password || typeof password !== "string" || password.length < 8) {
    return NextResponse.json({ error: "password must be at least 8 characters" }, { status: 400 });
  }

  const invite = await prisma.invite.findUnique({ where: { tokenHash: hashToken(params.token) } });
  if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) {
    return NextResponse.json({ error: "invite not found or expired" }, { status: 404 });
  }

  const existingMember = await prisma.member.findUnique({ where: { email: invite.email } });
  if (existingMember) {
    return NextResponse.json({ error: "a member with that email already exists" }, { status: 409 });
  }

  const member = await prisma.$transaction(async (tx) => {
    const created = await tx.member.create({
      data: {
        organizationId: invite.organizationId,
        email: invite.email,
        passwordHash: hashPassword(password),
      },
    });
    await tx.invite.update({ where: { id: invite.id }, data: { acceptedAt: new Date() } });
    return created;
  });

  await createSession(member.id);

  return NextResponse.json({ member: { id: member.id, email: member.email } }, { status: 201 });
}
