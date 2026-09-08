import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { computeRiskAssessment, recheckRiskAssessmentForSettlement, RiskGateBlockedError } from "@/lib/risk-engine";
import { parseVelocityLimits } from "@/lib/policy-engine";

// Phase 4's other highest-risk correctness property: the risk gate must
// actually BLOCK — not just annotate — when repeat-dispute/velocity
// signals cross a configured threshold, and must leave a normal case
// completely unaffected.

let orgId: string;
const caseIds: string[] = [];

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "risk-gate-test-org" } });
  orgId = org.id;
});

afterEach(async () => {
  await prisma.riskAssessment.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  caseIds.length = 0;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } });
});

async function makeCase(overrides: { claimantRef?: string; respondentRef?: string; amount?: string } = {}) {
  const kase = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim: "risk gate test",
      amount: overrides.amount ?? "100",
      claimantRef: overrides.claimantRef ?? "claimant-ref",
      respondentRef: overrides.respondentRef ?? "respondent-ref",
      policyId: "agent_data_task_v1",
      policyVersion: "1",
      status: "EVIDENCE_COLLECTION",
      claimantTokenHash: `hash-${Math.random()}`,
      respondentTokenHash: `hash-${Math.random()}`,
      claimantTokenExpiresAt: new Date(Date.now() + 86_400_000),
      respondentTokenExpiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  caseIds.push(kase.id);
  return kase;
}

const tightLimits = parseVelocityLimits({
  maxDisputesPerPartyPerWindow: 2,
  maxDisputesPerOrgPerWindow: 1000,
  rollingWindowDays: 30,
  maxVolumeUsdPerPartyPerWindow: 1_000_000,
});

describe("risk engine — computeRiskAssessment", () => {
  it("ALLOWs a brand-new claimant/respondent pair with no dispute history", async () => {
    const kase = await makeCase();
    const result = await computeRiskAssessment({
      organizationId: orgId,
      claimantRef: kase.claimantRef,
      respondentRef: kase.respondentRef,
      amountUsd: 100,
      velocityLimits: tightLimits,
    });
    expect(result.action).toBe("ALLOW");
  });

  it("escalates to REQUIRE_REVIEW when the same claimant/respondent pair has repeat disputes", async () => {
    const claimantRef = `repeat-claimant-${Math.random()}`;
    const respondentRef = `repeat-respondent-${Math.random()}`;
    await makeCase({ claimantRef, respondentRef });
    await makeCase({ claimantRef, respondentRef });
    await makeCase({ claimantRef, respondentRef });

    const result = await computeRiskAssessment({
      organizationId: orgId,
      claimantRef,
      respondentRef,
      amountUsd: 100,
      velocityLimits: tightLimits,
    });
    expect(result.action).toBe("REQUIRE_REVIEW");
    expect(result.repeatPairDisputeCount).toBeGreaterThanOrEqual(2);
    expect(result.reasons.some((r) => r.includes("repeat dispute"))).toBe(true);
  });

  it("escalates to REQUIRE_REVIEW when a claimant exceeds the configured per-party dispute velocity limit", async () => {
    const claimantRef = `velocity-claimant-${Math.random()}`;
    await makeCase({ claimantRef, respondentRef: "r1" });
    await makeCase({ claimantRef, respondentRef: "r2" });

    const result = await computeRiskAssessment({
      organizationId: orgId,
      claimantRef,
      respondentRef: "r3",
      amountUsd: 100,
      velocityLimits: tightLimits,
    });
    expect(result.action).toBe("REQUIRE_REVIEW");
  });
});

describe("recheckRiskAssessmentForSettlement — settlement-time gate", () => {
  it("throws RiskGateBlockedError and durably records the recheck when velocity has crossed the limit since case creation", async () => {
    const claimantRef = `settlement-velocity-claimant-${Math.random()}`;
    const respondentRef = `settlement-velocity-respondent-${Math.random()}`;
    const kase = await makeCase({ claimantRef, respondentRef });
    await prisma.riskAssessment.create({
      data: {
        caseId: kase.id,
        action: "ALLOW",
        reasons: ["no risk signals detected"],
        claimantRecentDisputeCount: 0,
        respondentRecentDisputeCount: 0,
        repeatPairDisputeCount: 0,
        orgRollingDisputeCount: 0,
        orgRollingVolumeUsd: "0",
      },
    });

    // Two more disputes for the same pair appear AFTER this case was
    // created but before it settles.
    await makeCase({ claimantRef, respondentRef });
    await makeCase({ claimantRef, respondentRef });

    await expect(recheckRiskAssessmentForSettlement(kase.id, tightLimits)).rejects.toThrow(RiskGateBlockedError);

    const reloaded = await prisma.riskAssessment.findUniqueOrThrow({ where: { caseId: kase.id } });
    expect(reloaded.recheckedAt).not.toBeNull();
    expect(reloaded.recheckAction).toBe("REQUIRE_REVIEW");
    // The original computedAt-time action is untouched by the recheck.
    expect(reloaded.action).toBe("ALLOW");
  });

  it("does not throw for a case with no risk signals at settlement time", async () => {
    const kase = await makeCase({ claimantRef: `clean-claimant-${Math.random()}`, respondentRef: `clean-respondent-${Math.random()}` });
    await prisma.riskAssessment.create({
      data: {
        caseId: kase.id,
        action: "ALLOW",
        reasons: ["no risk signals detected"],
        claimantRecentDisputeCount: 0,
        respondentRecentDisputeCount: 0,
        repeatPairDisputeCount: 0,
        orgRollingDisputeCount: 0,
        orgRollingVolumeUsd: "0",
      },
    });

    await expect(recheckRiskAssessmentForSettlement(kase.id, tightLimits)).resolves.toBeUndefined();
  });
});
