import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePlatformAdmin } from "@/lib/auth";
import { FINDING_SEVERITY } from "@/lib/reconciliation";

// GET /api/reconciliation-findings?status=open|resolved|all — Priority
// 5, item 18. Platform-admin-only, NOT org-OWNER-only: ReconciliationFinding
// is global, cross-tenant data (targetId can be another organization's
// SettlementIntegration or Organization row) — see lib/auth.ts's
// requirePlatformAdmin for why this can't just be requireOwner.
// Includes each finding's own remediation history
// (ReconciliationFindingEvent) so "what did we do about this" is
// answerable from the list itself.
export async function GET(req: NextRequest) {
  const member = await requirePlatformAdmin();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const status = req.nextUrl.searchParams.get("status") ?? "open";
  const where = status === "open" ? { resolvedAt: null } : status === "resolved" ? { resolvedAt: { not: null } } : {};

  const findings = await prisma.reconciliationFinding.findMany({
    where,
    include: { events: { orderBy: { createdAt: "asc" } } },
    orderBy: [{ resolvedAt: "asc" }, { openedAt: "desc" }],
  });

  // memberId on a finding/event is a plain string, not a Prisma
  // relation (findings are cross-tenant; a Member relation would force
  // every finding to belong to one organization, which isn't true) —
  // resolved to a display email here, once, for every distinct id
  // referenced, rather than N+1 queries per finding.
  const memberIds = new Set<string>();
  for (const f of findings) {
    if (f.acknowledgedByMemberId) memberIds.add(f.acknowledgedByMemberId);
    for (const e of f.events) memberIds.add(e.memberId);
  }
  const members = memberIds.size > 0 ? await prisma.member.findMany({ where: { id: { in: [...memberIds] } }, select: { id: true, email: true } }) : [];
  const emailByMemberId = new Map(members.map((m) => [m.id, m.email]));

  return NextResponse.json(
    findings.map((f) => ({
      ...f,
      severity: FINDING_SEVERITY[f.type] ?? "warning",
      acknowledgedByEmail: f.acknowledgedByMemberId ? (emailByMemberId.get(f.acknowledgedByMemberId) ?? f.acknowledgedByMemberId) : null,
      events: f.events.map((e) => ({ ...e, memberEmail: emailByMemberId.get(e.memberId) ?? e.memberId })),
    }))
  );
}
