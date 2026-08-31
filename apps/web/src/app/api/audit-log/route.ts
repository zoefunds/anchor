import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";

// GET /api/audit-log — recent org activity. OWNER-only.
export async function GET(req: NextRequest) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 100, 500);

  const [entries, memberEmails, apiKeyNames] = await Promise.all([
    prisma.auditLog.findMany({
      where: { organizationId: member.organizationId },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.member.findMany({ where: { organizationId: member.organizationId }, select: { id: true, email: true } }),
    prisma.apiKey.findMany({ where: { organizationId: member.organizationId }, select: { id: true, name: true } }),
  ]);

  const memberById = new Map(memberEmails.map((m: { id: string; email: string }) => [m.id, m.email]));
  const apiKeyById = new Map(apiKeyNames.map((k: { id: string; name: string }) => [k.id, k.name]));

  return NextResponse.json(
    entries.map((e) => ({
      id: e.id,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      metadata: e.metadata,
      createdAt: e.createdAt,
      actor: e.memberId
        ? { type: "member", label: memberById.get(e.memberId) ?? e.memberId }
        : e.apiKeyId
          ? { type: "api_key", label: apiKeyById.get(e.apiKeyId) ?? e.apiKeyId }
          : { type: "unknown", label: "unknown" },
    }))
  );
}
