import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePlatformAdmin } from "@/lib/auth";

// POST /api/reconciliation-findings/:id/acknowledge — records that a
// real person has taken ownership of this finding. Never changes the
// finding's own open/resolved state — only the sweep itself (having
// re-checked the real condition) can resolve a finding. Optional
// { note } is recorded as the first ReconciliationFindingEvent.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const member = await requirePlatformAdmin();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const finding = await prisma.reconciliationFinding.findUnique({ where: { id: (await params).id } });
  if (!finding) {
    return NextResponse.json({ error: "finding not found" }, { status: 404 });
  }

  const { note } = await req.json().catch(() => ({ note: undefined }));

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.reconciliationFinding.update({
      where: { id: (await params).id },
      data: { acknowledgedAt: new Date(), acknowledgedByMemberId: member.memberId },
    });
    await tx.reconciliationFindingEvent.create({
      data: { findingId: (await params).id, type: "ACKNOWLEDGED", memberId: member.memberId, note: typeof note === "string" && note.length > 0 ? note : null },
    });
    return result;
  });

  return NextResponse.json(updated);
}
