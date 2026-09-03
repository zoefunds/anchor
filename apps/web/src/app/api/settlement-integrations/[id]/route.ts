import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { logAction } from "@/lib/audit";

// PATCH /api/settlement-integrations/:id — OWNER-only toggle of
// `active` and `requireKycApproval`. Everything else about an
// integration (chain, escrowContractAddress, asset) is immutable after
// creation — changing which contract a "live" integration points to
// is exactly the kind of silent-rewire this project's own incident
// this session was about; retiring one (active: false) and creating a
// fresh one is the safe path, not editing this one in place.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const existing = await prisma.settlementIntegration.findUnique({ where: { id: params.id } });
  if (!existing || existing.organizationId !== member.organizationId) {
    return NextResponse.json({ error: "settlement integration not found" }, { status: 404 });
  }

  const body = await req.json();
  const data: { active?: boolean; requireKycApproval?: boolean } = {};
  if (typeof body.active === "boolean") data.active = body.active;
  if (typeof body.requireKycApproval === "boolean") data.requireKycApproval = body.requireKycApproval;
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "nothing to update — provide active and/or requireKycApproval" }, { status: 400 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.settlementIntegration.update({ where: { id: params.id }, data });
    await logAction(
      {
        organizationId: member.organizationId,
        memberId: member.memberId,
        action: "settlement_integration.updated",
        targetType: "SettlementIntegration",
        targetId: params.id,
        metadata: { ...data },
      },
      tx
    );
    return result;
  });

  return NextResponse.json(updated);
}
