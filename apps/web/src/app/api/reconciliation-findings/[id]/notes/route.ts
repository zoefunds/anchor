import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePlatformAdmin } from "@/lib/auth";

// POST /api/reconciliation-findings/:id/notes — adds a remediation
// note to a finding's real, queryable history, independent of
// acknowledgement (a finding can accumulate multiple notes over time
// as an incident is worked, e.g. "paged on-call", "root cause found",
// "fix deployed, watching for resolution").
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const member = await requirePlatformAdmin();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const finding = await prisma.reconciliationFinding.findUnique({ where: { id: params.id } });
  if (!finding) {
    return NextResponse.json({ error: "finding not found" }, { status: 404 });
  }

  const { note } = await req.json();
  if (typeof note !== "string" || note.trim().length === 0) {
    return NextResponse.json({ error: "note is required" }, { status: 400 });
  }

  const event = await prisma.reconciliationFindingEvent.create({
    data: { findingId: params.id, type: "NOTE", memberId: member.memberId, note },
  });

  return NextResponse.json(event, { status: 201 });
}
