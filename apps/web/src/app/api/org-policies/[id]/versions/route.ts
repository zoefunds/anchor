import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { publishPolicyVersion, PolicyEngineError, DEFAULT_VELOCITY_LIMITS, DEFAULT_HUMAN_REVIEW_TRIGGERS } from "@/lib/policy-engine";

// POST /api/org-policies/:id/versions — publish a new immutable version
// under an existing Policy. This is "editing a policy" in this system:
// it never mutates a prior PolicyVersion row, it only inserts a new one
// and deactivates the old one for future case binding. Every case
// already bound to the old version keeps reading it unchanged — see
// Case.policyVersionRecordId's schema comment.
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const policy = await prisma.policy.findUnique({ where: { id: params.id } });
  if (!policy || policy.organizationId !== member.organizationId) {
    return NextResponse.json({ error: "policy not found" }, { status: 404 });
  }

  const body = await req.json();
  const { evidenceDeadlineHours, appealWindowHours, allowedOutcomes, autoSettlementCapNative, allowedAssets, allowedChains, kycRequired, velocityLimits, humanReviewTriggers } = body;

  if (!evidenceDeadlineHours || !appealWindowHours || !Array.isArray(allowedOutcomes)) {
    return NextResponse.json(
      { error: "evidenceDeadlineHours, appealWindowHours, allowedOutcomes are required" },
      { status: 400 }
    );
  }

  try {
    const version = await publishPolicyVersion(policy.id, {
      evidenceDeadlineHours,
      appealWindowHours,
      allowedOutcomes,
      autoSettlementCapNative: autoSettlementCapNative ?? null,
      allowedAssets: allowedAssets ?? [],
      allowedChains: allowedChains ?? [],
      kycRequired: Boolean(kycRequired),
      velocityLimits: { ...DEFAULT_VELOCITY_LIMITS, ...velocityLimits },
      humanReviewTriggers: { ...DEFAULT_HUMAN_REVIEW_TRIGGERS, ...humanReviewTriggers },
      publishedByMemberId: member.memberId,
    });

    await logAction({
      organizationId: member.organizationId,
      memberId: member.memberId,
      action: "policy.published",
      targetType: "policy_version",
      targetId: version.id,
      metadata: { policyId: policy.id, version: version.version },
    });

    return NextResponse.json(version, { status: 201 });
  } catch (err) {
    if (err instanceof PolicyEngineError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
