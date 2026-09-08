import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  escalateForAppeal,
  escalateForKycSanctions,
  escalateForSettlementFailure,
  castReviewApproval,
  toPartyVisibleReviewStatus,
} from "@/lib/escalation";

// Track 5, item 5: proves the new deterministic escalation triggers
// (APPEAL_FILED, KYC_SANCTIONS, SETTLEMENT_FAILED) actually create a
// CaseReview with the right trigger, are idempotent, and that a
// reviewer's vote now commits atomically with its own AuditLog entry
// (the real gap found: castReviewApproval used to leave audit logging
// to the route handler, called separately after the vote's own
// transaction committed).

let orgId: string;
const caseIds: string[] = [];

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "escalation-triggers-test-org" } });
  orgId = org.id;
});

afterEach(async () => {
  await prisma.caseReviewApproval.deleteMany({ where: { review: { case: { organizationId: orgId } } } });
  await prisma.caseReview.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  caseIds.length = 0;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } });
});

async function makeCase() {
  const kase = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim: "escalation trigger test",
      amount: "100",
      claimantRef: "claimant-ref",
      respondentRef: "respondent-ref",
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

describe("new deterministic escalation triggers", () => {
  it("escalateForAppeal opens a CaseReview with trigger APPEAL_FILED", async () => {
    const kase = await makeCase();
    const review = await escalateForAppeal(kase.id);
    expect(review?.trigger).toBe("APPEAL_FILED");
    expect(toPartyVisibleReviewStatus(review!)?.reason).toBe("appeal_review");
  });

  it("escalateForKycSanctions opens a CaseReview with trigger KYC_SANCTIONS", async () => {
    const kase = await makeCase();
    const review = await escalateForKycSanctions(kase.id);
    expect(review?.trigger).toBe("KYC_SANCTIONS");
  });

  it("escalateForSettlementFailure opens a CaseReview with trigger SETTLEMENT_FAILED", async () => {
    const kase = await makeCase();
    const review = await escalateForSettlementFailure(kase.id);
    expect(review?.trigger).toBe("SETTLEMENT_FAILED");
  });

  it("is idempotent: a second trigger on the same case does not overwrite the first review", async () => {
    const kase = await makeCase();
    const first = await escalateForAppeal(kase.id);
    const second = await escalateForKycSanctions(kase.id);
    expect(second.id).toBe(first!.id);
    expect(second.trigger).toBe("APPEAL_FILED"); // unchanged — first trigger wins
  });
});

describe("castReviewApproval — vote and its audit entry commit atomically", () => {
  it("records an AuditLog row for the vote in the same call, attributed to the voting member", async () => {
    const kase = await makeCase();
    const review = await escalateForAppeal(kase.id);
    const member = await prisma.member.create({
      data: { organizationId: orgId, email: `reviewer-${Math.random()}@example.com`, passwordHash: "test-hash", role: "MEMBER" },
    });

    await castReviewApproval(review!.id, member.id, "APPROVE", "looks fine", orgId);

    const logs = await prisma.auditLog.findMany({ where: { organizationId: orgId, action: "case.review_voted" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].memberId).toBe(member.id);
    expect(logs[0].targetId).toBe(review!.id);
    expect((logs[0].metadata as { decision: string }).decision).toBe("APPROVE");

    const resolved = await prisma.caseReview.findUniqueOrThrow({ where: { id: review!.id } });
    expect(resolved.status).toBe("APPROVED");

    await prisma.member.delete({ where: { id: member.id } });
  });
});
