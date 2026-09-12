import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { createPolicy, publishPolicyVersion, DEFAULT_VELOCITY_LIMITS, DEFAULT_HUMAN_REVIEW_TRIGGERS } from "@/lib/policy-engine";
import { assertKycPolicyRequirementMet, KycPolicyRequirementNotMetError, recordManualOverride } from "@/lib/kyc/kyc-gate";
import { buildTestProviderWebhookPayload } from "@/lib/kyc/test-provider-adapter";
import { POST as kycWebhookPost } from "@/app/api/kyc/webhook/route";

// Coverage for Track 3's real enforcement of PolicyVersion.kycRequired
// (see kyc-gate.ts's header comment for why this is a separate gate
// from the pre-existing lib/settlement-kyc.ts one, which the sibling
// tests/integration/settlement-kyc-gate.test.ts already covers).

process.env.KYC_PROVIDER = "test";
process.env.KYC_TEST_WEBHOOK_SECRET = "test-provider-shared-secret";

let orgId: string;
let memberId = "test-member-kyc-gate";
const caseIds: string[] = [];
const policyIds: string[] = [];

async function makePolicyVersion(kycRequired: boolean) {
  const policy = await createPolicy(orgId, `kyc-gate-test-${Math.random()}`, "KYC gate test policy");
  policyIds.push(policy.id);
  const version = await publishPolicyVersion(policy.id, {
    evidenceDeadlineHours: 72,
    appealWindowHours: 24,
    allowedOutcomes: ["CLAIMANT", "RESPONDENT"],
    autoSettlementCapNative: null,
    allowedAssets: ["ETH-sepolia"],
    allowedChains: ["sepolia"],
    kycRequired,
    velocityLimits: DEFAULT_VELOCITY_LIMITS,
    humanReviewTriggers: DEFAULT_HUMAN_REVIEW_TRIGGERS,
  });
  return version;
}

async function makeCase(policyVersionRecordId: string | null) {
  const kase = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim: "kyc policy gate test",
      amount: "100",
      claimantRef: "claimant-ref",
      respondentRef: "respondent-ref",
      policyId: "agent_data_task_v1",
      policyVersion: "1",
      policyVersionRecordId,
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

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "kyc-policy-gate-test-org" } });
  orgId = org.id;
});

afterEach(async () => {
  await prisma.partyVerificationEvent.deleteMany({ where: { partyVerification: { caseId: { in: caseIds } } } });
  await prisma.partyVerification.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.policyVersion.deleteMany({ where: { policyId: { in: policyIds } } });
  await prisma.policy.deleteMany({ where: { id: { in: policyIds } } });
  caseIds.length = 0;
  policyIds.length = 0;
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
});

describe("assertKycPolicyRequirementMet", () => {
  it("no-ops when the case has no bound PolicyVersion", async () => {
    const kase = await makeCase(null);
    await expect(assertKycPolicyRequirementMet(kase.id)).resolves.toBeUndefined();
  });

  it("no-ops when the bound PolicyVersion has kycRequired=false", async () => {
    const version = await makePolicyVersion(false);
    const kase = await makeCase(version.id);
    await expect(assertKycPolicyRequirementMet(kase.id)).resolves.toBeUndefined();
  });

  it("blocks when kycRequired=true and neither party is verified", async () => {
    const version = await makePolicyVersion(true);
    const kase = await makeCase(version.id);
    await expect(assertKycPolicyRequirementMet(kase.id)).rejects.toThrow(KycPolicyRequirementNotMetError);
  });

  it("blocks when a party is APPROVED but bound to a DIFFERENT PolicyVersion", async () => {
    const version = await makePolicyVersion(true);
    const otherVersion = await makePolicyVersion(true);
    const kase = await makeCase(version.id);
    await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "claimant", sessionId: `s-${Math.random()}`, status: "APPROVED", policyVersionId: otherVersion.id },
    });
    await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "respondent", sessionId: `s-${Math.random()}`, status: "APPROVED", policyVersionId: otherVersion.id },
    });
    await expect(assertKycPolicyRequirementMet(kase.id)).rejects.toThrow(/claimant, respondent/);
  });

  it("blocks when a party's verification is APPROVED but expired", async () => {
    const version = await makePolicyVersion(true);
    const kase = await makeCase(version.id);
    await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "claimant", sessionId: `s-${Math.random()}`, status: "APPROVED", policyVersionId: version.id, expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "respondent", sessionId: `s-${Math.random()}`, status: "APPROVED", policyVersionId: version.id },
    });
    await expect(assertKycPolicyRequirementMet(kase.id)).rejects.toThrow(/claimant/);
  });

  it("allows settlement once BOTH parties are APPROVED and bound to the case's own PolicyVersion", async () => {
    const version = await makePolicyVersion(true);
    const kase = await makeCase(version.id);
    await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "claimant", sessionId: `s-${Math.random()}`, status: "APPROVED", policyVersionId: version.id },
    });
    await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "respondent", sessionId: `s-${Math.random()}`, status: "APPROVED", policyVersionId: version.id },
    });
    await expect(assertKycPolicyRequirementMet(kase.id)).resolves.toBeUndefined();
  });
});

describe("POST /api/kyc/webhook", () => {
  it("transitions a PartyVerification on a validly-signed webhook and records an event", async () => {
    const version = await makePolicyVersion(true);
    const kase = await makeCase(version.id);
    const pv = await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "claimant", sessionId: "test_session_webhook_1", status: "IN_PROGRESS", policyVersionId: version.id },
    });

    const { rawBody, signature } = buildTestProviderWebhookPayload("test_session_webhook_1", "APPROVED");
    const req = new NextRequest("http://test/api/kyc/webhook", {
      method: "POST",
      body: rawBody,
      headers: { "x-test-kyc-signature": signature },
    });
    const res = await kycWebhookPost(req);
    expect(res.status).toBe(200);

    const updated = await prisma.partyVerification.findUniqueOrThrow({ where: { id: pv.id } });
    expect(updated.status).toBe("APPROVED");

    const events = await prisma.partyVerificationEvent.findMany({ where: { partyVerificationId: pv.id } });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("webhook");
    expect(events[0].toStatus).toBe("APPROVED");
  });

  it("rejects a forged signature with 401 and does not transition anything", async () => {
    const version = await makePolicyVersion(true);
    const kase = await makeCase(version.id);
    const pv = await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "claimant", sessionId: "test_session_webhook_2", status: "IN_PROGRESS", policyVersionId: version.id },
    });

    const req = new NextRequest("http://test/api/kyc/webhook", {
      method: "POST",
      body: JSON.stringify({ event_id: "forged-1", session_id: "test_session_webhook_2", status: "APPROVED" }),
      headers: { "x-test-kyc-signature": "0000000000000000000000000000000000000000000000000000000000000000" },
    });
    const res = await kycWebhookPost(req);
    expect(res.status).toBe(401);

    const unchanged = await prisma.partyVerification.findUniqueOrThrow({ where: { id: pv.id } });
    expect(unchanged.status).toBe("IN_PROGRESS");
  });

  it("dedupes a replayed (same providerEventId) webhook and does not transition a second time", async () => {
    const version = await makePolicyVersion(true);
    const kase = await makeCase(version.id);
    const pv = await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "respondent", sessionId: "test_session_webhook_3", status: "IN_PROGRESS", policyVersionId: version.id },
    });

    const { rawBody, signature } = buildTestProviderWebhookPayload("test_session_webhook_3", "APPROVED");

    const firstReq = new NextRequest("http://test/api/kyc/webhook", { method: "POST", body: rawBody, headers: { "x-test-kyc-signature": signature } });
    const firstRes = await kycWebhookPost(firstReq);
    expect(firstRes.status).toBe(200);
    expect((await firstRes.json()).deduped).toBeUndefined();

    // Manually revert status to prove a replay of the SAME event can't
    // re-trigger a transition even if the row's current state would
    // otherwise make that transition look like a legitimate no-op change.
    await prisma.partyVerification.update({ where: { id: pv.id }, data: { status: "IN_PROGRESS" } });

    const secondReq = new NextRequest("http://test/api/kyc/webhook", { method: "POST", body: rawBody, headers: { "x-test-kyc-signature": signature } });
    const secondRes = await kycWebhookPost(secondReq);
    expect(secondRes.status).toBe(200);
    expect((await secondRes.json()).deduped).toBe(true);

    const afterReplay = await prisma.partyVerification.findUniqueOrThrow({ where: { id: pv.id } });
    expect(afterReplay.status).toBe("IN_PROGRESS"); // replay must NOT have re-approved it

    const events = await prisma.partyVerificationEvent.findMany({ where: { partyVerificationId: pv.id } });
    expect(events).toHaveLength(1); // only the first, genuine delivery wrote an event
  });
});

describe("recordManualOverride", () => {
  it("requires a documented reason and a non-empty note, and writes an AuditLog + PartyVerificationEvent", async () => {
    const version = await makePolicyVersion(true);
    const kase = await makeCase(version.id);
    const pv = await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "claimant", sessionId: `s-${Math.random()}`, status: "IN_REVIEW", policyVersionId: version.id },
    });

    await recordManualOverride({
      partyVerificationId: pv.id,
      organizationId: orgId,
      actingMemberId: memberId,
      reason: "PROVIDER_OUTAGE",
      note: "Provider sandbox was down; manually confirmed identity via alternate channel.",
      toStatus: "APPROVED",
    });

    const updated = await prisma.partyVerification.findUniqueOrThrow({ where: { id: pv.id } });
    expect(updated.status).toBe("APPROVED");

    const events = await prisma.partyVerificationEvent.findMany({ where: { partyVerificationId: pv.id } });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("manual_override");
    expect(events[0].actingMemberId).toBe(memberId);

    const auditRows = await prisma.auditLog.findMany({ where: { organizationId: orgId, action: "party_verification.manual_override" } });
    expect(auditRows.length).toBeGreaterThan(0);
  });

  it("rejects an empty note even with a valid reason", async () => {
    const version = await makePolicyVersion(true);
    const kase = await makeCase(version.id);
    const pv = await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "claimant", sessionId: `s-${Math.random()}`, status: "IN_REVIEW", policyVersionId: version.id },
    });

    await expect(
      recordManualOverride({
        partyVerificationId: pv.id,
        organizationId: orgId,
        actingMemberId: memberId,
        reason: "PROVIDER_OUTAGE",
        note: "   ",
        toStatus: "APPROVED",
      })
    ).rejects.toThrow(/non-empty note/);
  });
});
