import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePlatformAdmin } from "@/lib/auth";

// GET /api/reliability-observations — re-audit response, Phase 1 item 3.
// Platform-admin-only, same reasoning as reconciliation-findings:
// ReliabilityObservation is global infrastructure state, not scoped to
// any one organization.
export async function GET(req: NextRequest) {
  const member = await requirePlatformAdmin();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") ?? "200"), 1000);
  const observations = await prisma.reliabilityObservation.findMany({
    orderBy: { capturedAt: "desc" },
    take: limit,
  });

  return NextResponse.json(observations);
}
