import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { createPolicy, publishPolicyVersion, resolveActivePolicyVersion, DEFAULT_VELOCITY_LIMITS, DEFAULT_HUMAN_REVIEW_TRIGGERS } from "@/lib/policy-engine";

// Phase 4's single highest-risk correctness property for the policy
// engine: a Case's bound PolicyVersion must NEVER change after the case
// is created, even after the org publishes a newer version under the
// same Policy. This is the concrete meaning of "never let editing a
// policy retroactively change a live case."

let orgId: string;
const caseIds: string[] = [];
const policyIds: string[] = [];

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "policy-immutability-test-org" } });
  orgId = org.id;
});

afterEach(async () => {
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.policyVersion.deleteMany({ where: { policyId: { in: policyIds } } });
  await prisma.policy.deleteMany({ where: { id: { in: policyIds } } });
  caseIds.length = 0;
  policyIds.length = 0;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } });
});

async function makeCase(policyVersionRecordId: string | null) {
  const kase = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim: "policy immutability test",
      amount: "500",
      claimantRef: "claimant-ref",
      respondentRef: "respondent-ref",
      policyId: "agent_data_task_v1",
      policyVersion: "1",
      status: "EVIDENCE_COLLECTION",
      claimantTokenHash: `hash-${Math.random()}`,
      respondentTokenHash: `hash-${Math.random()}`,
      claimantTokenExpiresAt: new Date(Date.now() + 86_400_000),
      respondentTokenExpiresAt: new Date(Date.now() + 86_400_000),
      policyVersionRecordId,
    },
  });
  caseIds.push(kase.id);
  return kase;
}

describe("policy version binding immutability", () => {
  it("a case keeps pointing at the exact version it bound to, even after a newer version is published", async () => {
    const policy = await createPolicy(orgId, "default", "Default policy");
    policyIds.push(policy.id);

    const v1 = await publishPolicyVersion(policy.id, {
      evidenceDeadlineHours: 48,
      appealWindowHours: 48,
      allowedOutcomes: ["claimant", "respondent", "split"],
      autoSettlementCapUsd: 1000,
      allowedAssets: ["ETH"],
      allowedChains: ["sepolia"],
      kycRequired: false,
      velocityLimits: DEFAULT_VELOCITY_LIMITS,
      humanReviewTriggers: DEFAULT_HUMAN_REVIEW_TRIGGERS,
    });
    expect(v1.version).toBe(1);
    expect(v1.active).toBe(true);

    const kase = await makeCase(v1.id);

    // Publish a materially different v2 — different cap, different KYC
    // requirement — under the SAME Policy.
    const v2 = await publishPolicyVersion(policy.id, {
      evidenceDeadlineHours: 72,
      appealWindowHours: 72,
      allowedOutcomes: ["claimant", "respondent"],
      autoSettlementCapUsd: 50,
      allowedAssets: ["ETH"],
      allowedChains: ["sepolia"],
      kycRequired: true,
      velocityLimits: DEFAULT_VELOCITY_LIMITS,
      humanReviewTriggers: DEFAULT_HUMAN_REVIEW_TRIGGERS,
    });
    expect(v2.version).toBe(2);
    expect(v2.id).not.toBe(v1.id);

    // v1 is no longer active...
    const v1Reloaded = await prisma.policyVersion.findUniqueOrThrow({ where: { id: v1.id } });
    expect(v1Reloaded.active).toBe(false);

    // ...but the case's binding — and the actual field values it reads
    // through that binding — are completely untouched.
    const kaseReloaded = await prisma.case.findUniqueOrThrow({
      where: { id: kase.id },
      include: { policyVersionRecord: true },
    });
    expect(kaseReloaded.policyVersionRecordId).toBe(v1.id);
    expect(kaseReloaded.policyVersionRecord?.version).toBe(1);
    expect(Number(kaseReloaded.policyVersionRecord?.autoSettlementCapUsd)).toBe(1000);
    expect(kaseReloaded.policyVersionRecord?.kycRequired).toBe(false);

    // And resolveActivePolicyVersion — the function used ONLY at
    // case-creation time — now correctly resolves to v2 for any NEW case,
    // proving the "current" pointer really did move forward.
    const active = await resolveActivePolicyVersion(orgId, "default");
    expect(active?.id).toBe(v2.id);
  });

  it("publishing a new version never mutates an existing PolicyVersion row's own field values", async () => {
    const policy = await createPolicy(orgId, "default2", "Second policy");
    policyIds.push(policy.id);

    const v1 = await publishPolicyVersion(policy.id, {
      evidenceDeadlineHours: 24,
      appealWindowHours: 24,
      allowedOutcomes: ["claimant"],
      autoSettlementCapUsd: null,
      allowedAssets: [],
      allowedChains: [],
      kycRequired: false,
      velocityLimits: DEFAULT_VELOCITY_LIMITS,
      humanReviewTriggers: DEFAULT_HUMAN_REVIEW_TRIGGERS,
    });
    const v1Snapshot = { ...v1 };

    await publishPolicyVersion(policy.id, {
      evidenceDeadlineHours: 999,
      appealWindowHours: 999,
      allowedOutcomes: ["respondent"],
      autoSettlementCapUsd: 1,
      allowedAssets: ["ETH"],
      allowedChains: ["solanatestnet"],
      kycRequired: true,
      velocityLimits: DEFAULT_VELOCITY_LIMITS,
      humanReviewTriggers: DEFAULT_HUMAN_REVIEW_TRIGGERS,
    });

    const v1Reloaded = await prisma.policyVersion.findUniqueOrThrow({ where: { id: v1.id } });
    expect(v1Reloaded.evidenceDeadlineHours).toBe(v1Snapshot.evidenceDeadlineHours);
    expect(v1Reloaded.appealWindowHours).toBe(v1Snapshot.appealWindowHours);
    expect(v1Reloaded.allowedOutcomes).toEqual(v1Snapshot.allowedOutcomes);
    expect(v1Reloaded.kycRequired).toBe(v1Snapshot.kycRequired);
    // Only `active` is allowed to change on an existing row.
    expect(v1Reloaded.active).toBe(false);
  });
});
