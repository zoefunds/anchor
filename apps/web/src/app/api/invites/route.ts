import { randomBytes, createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSessionMember, requireOwner } from "@/lib/auth";
import { sendInviteEmail } from "@/lib/email";
import { logAction } from "@/lib/audit";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function appOrigin(req: NextRequest): string {
  return process.env.APP_ORIGIN || req.nextUrl.origin;
}

// GET /api/invites — list pending invites for the caller's org (dashboard-only, session auth).
export async function GET() {
  const member = await getSessionMember();
  if (!member) {
    return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }

  const invites = await prisma.invite.findMany({
    where: { organizationId: member.organizationId, acceptedAt: null },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    invites.map((i) => ({
      id: i.id,
      email: i.email,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
    }))
  );
}

// POST /api/invites — invite a new member into the caller's org. Dashboard-only
// (session auth), and OWNER-only: growing the org's membership is an
// owner decision, not something any member (let alone an API key) can do.
export async function POST(req: NextRequest) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json(
      { error: member.error === "forbidden" ? "only an org owner can invite members" : "authentication required" },
      { status: member.error === "forbidden" ? 403 : 401 }
    );
  }

  const { email, role } = await req.json();
  if (!email || typeof email !== "string") {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }
  const inviteRole = role === "VIEWER" ? "VIEWER" : "MEMBER"; // OWNER can never be invited-in — only the founding signup creates an owner

  const existingMember = await prisma.member.findUnique({ where: { email } });
  if (existingMember) {
    return NextResponse.json({ error: "a member with that email already exists" }, { status: 409 });
  }

  const organization = await prisma.organization.findUniqueOrThrow({
    where: { id: member.organizationId },
  });

  const rawToken = randomBytes(32).toString("hex");
  const invite = await prisma.invite.create({
    data: {
      organizationId: member.organizationId,
      email,
      role: inviteRole,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });

  const inviteUrl = `${appOrigin(req)}/invite/${rawToken}`;
  await logAction({
    organizationId: member.organizationId,
    memberId: member.memberId,
    action: "invite.created",
    targetType: "invite",
    targetId: invite.id,
    metadata: { email, role: inviteRole },
  });

  try {
    await sendInviteEmail({ to: email, organizationName: organization.name, inviteUrl });
  } catch (err) {
    // The invite record still exists and the link is still valid even if
    // the email failed to send — surface both so the caller can hand the
    // link to the invitee directly if needed.
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { invite: { id: invite.id, email: invite.email }, inviteUrl, emailError: message },
      { status: 201 }
    );
  }

  return NextResponse.json({ invite: { id: invite.id, email: invite.email }, inviteUrl }, { status: 201 });
}
