import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner, generateApiKey } from "@/lib/auth";
import { logAction } from "@/lib/audit";

// POST /api/api-keys/:id/rotate — mints a replacement key that carries
// over the old one's name/scopes/restrictedToCaseIds/expiry-length, then
// revokes the old one, atomically. OWNER-only, same rationale as
// ../route.ts and ../[id]/route.ts's DELETE (rotation is just as
// privileged as creation/revocation, and API keys still can't manage
// other API keys). Doing it as one transaction means there's never a
// moment where both the old and new key are simultaneously live, or
// where the old is dead and the new doesn't exist yet.
export async function POST(_req: NextRequest, { params }: { params: { id: string } }) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const old = await prisma.apiKey.findUnique({ where: { id: params.id } });
  if (!old || old.organizationId !== member.organizationId) {
    return NextResponse.json({ error: "key not found" }, { status: 404 });
  }
  if (old.revokedAt) {
    return NextResponse.json({ error: "this key is already revoked" }, { status: 409 });
  }

  const expiresInMs = old.expiresAt ? old.expiresAt.getTime() - old.createdAt.getTime() : null;
  const newExpiresAt = expiresInMs !== null ? new Date(Date.now() + expiresInMs) : null;

  const { raw, prefix, hash } = generateApiKey();
  const created = await prisma.$transaction(async (tx) => {
    const next = await tx.apiKey.create({
      data: {
        organizationId: old.organizationId,
        name: old.name,
        keyHash: hash,
        keyPrefix: prefix,
        creatorMemberId: member.memberId,
        expiresAt: newExpiresAt,
        restrictedToCaseIds: old.restrictedToCaseIds,
        scopes: old.scopes,
        rotatedFromKeyId: old.id,
      },
    });
    await tx.apiKey.update({ where: { id: old.id }, data: { revokedAt: new Date() } });
    await logAction(
      {
        organizationId: member.organizationId,
        memberId: member.memberId,
        action: "api_key.rotated",
        targetType: "apiKey",
        targetId: next.id,
        metadata: { rotatedFromKeyId: old.id, name: old.name, keyPrefix: prefix },
      },
      tx
    );
    return next;
  });

  return NextResponse.json(
    {
      id: created.id,
      name: created.name,
      keyPrefix: created.keyPrefix,
      key: raw,
      createdAt: created.createdAt,
      expiresAt: created.expiresAt,
      restrictedToCaseIds: created.restrictedToCaseIds,
      scopes: created.scopes,
      rotatedFromKeyId: old.id,
    },
    { status: 201 }
  );
}
