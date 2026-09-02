import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner, generateApiKey } from "@/lib/auth";
import { logAction } from "@/lib/audit";

// API keys can only be managed via a dashboard session, not another API
// key — otherwise a leaked key could mint itself unlimited replacements.
//
// Real P0 fixed here (found by an external audit): this used to accept
// any authenticated session member, including VIEWER. An API key carries
// no role of its own — resolveOrgFromRequest's OrgAuthResult only sets
// `role` for session callers, so an API-key-authenticated request always
// passes requireWriteAccess's VIEWER check. That meant a read-only member
// could mint a key and use it to bypass their own read-only restriction
// entirely, becoming an unrestricted org-wide writer. Management is now
// OWNER-only, matching the same requireOwner() gate this project already
// uses for webhooks/member management/audit log.
export async function GET() {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }
  const keys = await prisma.apiKey.findMany({
    where: { organizationId: member.organizationId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, keyPrefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
  });
  return NextResponse.json(keys);
}

export async function POST(req: NextRequest) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }
  const { name } = await req.json();
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  // Real audit-completeness gap fixed here (external audit finding):
  // API-key creation — a genuinely security-sensitive action, now
  // OWNER-only for exactly that reason — was never audited at all.
  // Wrapped in one transaction with the audit write, same pattern as
  // case/webhook creation elsewhere in this project: either both commit,
  // or neither does, so a failed audit write can never leave a silently
  // unlogged privileged action.
  const { raw, prefix, hash } = generateApiKey();
  const key = await prisma.$transaction(async (tx) => {
    const created = await tx.apiKey.create({
      data: { organizationId: member.organizationId, name, keyHash: hash, keyPrefix: prefix },
    });
    await logAction(
      {
        organizationId: member.organizationId,
        memberId: member.memberId,
        action: "api_key.created",
        targetType: "apiKey",
        targetId: created.id,
        metadata: { name, keyPrefix: prefix },
      },
      tx
    );
    return created;
  });

  // The raw key is returned exactly once, here — it is never retrievable
  // again after this response.
  return NextResponse.json(
    { id: key.id, name: key.name, keyPrefix: key.keyPrefix, key: raw, createdAt: key.createdAt },
    { status: 201 }
  );
}
