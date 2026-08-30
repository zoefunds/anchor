import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, createSession } from "@/lib/auth";

// POST /api/auth/signup — creates a new Organization + the first Member,
// then a session. This is the only way an Organization gets created;
// every subsequent member of that org signs up via an invite flow that
// doesn't exist yet (see Still needed in genlayer/README-equivalent notes
// — MVP scope is one member per org for now).
export async function POST(req: NextRequest) {
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
    },
  });

  await createSession(member.id);

  return NextResponse.json(
    { organization: { id: organization.id, name: organization.name }, member: { id: member.id, email: member.email } },
    { status: 201 }
  );
}
