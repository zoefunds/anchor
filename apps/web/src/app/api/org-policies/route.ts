import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { createPolicy, publishPolicyVersion, PolicyEngineError, DEFAULT_VELOCITY_LIMITS, DEFAULT_HUMAN_REVIEW_TRIGGERS } from "@/lib/policy-engine";

// GET/POST /api/org-policies — Phase 4's organization-scoped, versioned
// policy configuration (evidence deadlines, appeal windows, KYC
// requirement, auto-settlement cap, velocity limits, human-review
// triggers). Deliberately a separate path from GET /api/policies, which
// already exists and lists the fixed, unrelated set of GenLayer
// adjudication-logic policies (lib/policies.ts's POLICIES registry) —
// this is a different concept (an org's own governance config, not
// adjudication-prompt selection) and must not collide with that route.
//
// OWNER-only, same governance-sensitivity tier as settlement-integrations.
export async function GET() {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const policies = await prisma.policy.findMany({
    where: { organizationId: member.organizationId },
    include: { versions: { orderBy: { version: "desc" } } },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(policies);
}

// POST /api/org-policies — create a new named policy slot and publish
// its first version in one call. Body: { key, name, ...PublishPolicyVersionInput }.
// To publish a subsequent version of an EXISTING policy, use POST
// /api/org-policies/:id/versions instead — this route always creates
// (or, idempotently, reuses) the Policy row itself.
export async function POST(req: NextRequest) {
  const member = await requireOwner();
  if ("error" in member) {
    return NextResponse.json({ error: member.error }, { status: member.error === "forbidden" ? 403 : 401 });
  }

  const body = await req.json();
  const { key, name, evidenceDeadlineHours, appealWindowHours, allowedOutcomes, autoSettlementCapNative, allowedAssets, allowedChains, kycRequired, velocityLimits, humanReviewTriggers } = body;

  if (!key || !name || !evidenceDeadlineHours || !appealWindowHours || !Array.isArray(allowedOutcomes)) {
    return NextResponse.json(
      { error: "key, name, evidenceDeadlineHours, appealWindowHours, allowedOutcomes are required" },
      { status: 400 }
    );
  }

  try {
    const policy = await createPolicy(member.organizationId, key, name);
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

    return NextResponse.json({ policy, version }, { status: 201 });
  } catch (err) {
    if (err instanceof PolicyEngineError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
