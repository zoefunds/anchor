import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { assertKycRequirementMet, KycRequirementNotMetError } from "@/lib/settlement-kyc";

// Regression coverage for the KYC settlement gate: dispatchDecisionForCase
// must refuse to settle a case whose SettlementIntegration requires KYC
// approval unless BOTH parties (claimant and respondent) have an APPROVED
// PartyVerification — and must never block a case whose integration
// doesn't require it, or that has no CaseSettlement at all.

let orgId: string;
const caseIds: string[] = [];
const integrationIds: string[] = [];

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "settlement-kyc-gate-test-org" } });
  orgId = org.id;
});

afterEach(async () => {
  await prisma.partyVerification.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.caseSettlement.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.settlementIntegration.deleteMany({ where: { id: { in: integrationIds } } });
  caseIds.length = 0;
  integrationIds.length = 0;
});

afterAll(async () => {
  await prisma.organization.delete({ where: { id: orgId } });
});

async function makeCase() {
  const kase = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim: "kyc gate test",
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

async function makeIntegration(requireKycApproval: boolean) {
  const integration = await prisma.settlementIntegration.create({
    data: {
      organizationId: orgId,
      chain: "sepolia",
      escrowContractAddress: "0x0000000000000000000000000000000000000001",
      assetSymbol: "TEST",
      assetDecimals: 18,
      requireKycApproval,
      createdByMemberId: "test-member",
    },
  });
  integrationIds.push(integration.id);
  return integration;
}

describe("assertKycRequirementMet", () => {
  it("no-ops when the case has no CaseSettlement at all", async () => {
    const kase = await makeCase();
    await expect(assertKycRequirementMet(kase.id)).resolves.toBeUndefined();
  });

  it("no-ops when the integration does not require KYC", async () => {
    const kase = await makeCase();
    const integration = await makeIntegration(false);
    await prisma.caseSettlement.create({
      data: {
        caseId: kase.id,
        integrationId: integration.id,
        escrowId: "1",
        claimantAddress: "0x0000000000000000000000000000000000000002",
        respondentAddress: "0x0000000000000000000000000000000000000003",
        expectedAmountAtto: "1000000000000000000",
      },
    });
    await expect(assertKycRequirementMet(kase.id)).resolves.toBeUndefined();
  });

  it("blocks when the integration requires KYC and neither party is verified", async () => {
    const kase = await makeCase();
    const integration = await makeIntegration(true);
    await prisma.caseSettlement.create({
      data: {
        caseId: kase.id,
        integrationId: integration.id,
        escrowId: "1",
        claimantAddress: "0x0000000000000000000000000000000000000002",
        respondentAddress: "0x0000000000000000000000000000000000000003",
        expectedAmountAtto: "1000000000000000000",
      },
    });
    await expect(assertKycRequirementMet(kase.id)).rejects.toThrow(KycRequirementNotMetError);
    try {
      await assertKycRequirementMet(kase.id);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(KycRequirementNotMetError);
      expect((err as KycRequirementNotMetError).missingRoles).toEqual(["claimant", "respondent"]);
    }
  });

  it("blocks when only one party is APPROVED", async () => {
    const kase = await makeCase();
    const integration = await makeIntegration(true);
    await prisma.caseSettlement.create({
      data: {
        caseId: kase.id,
        integrationId: integration.id,
        escrowId: "1",
        claimantAddress: "0x0000000000000000000000000000000000000002",
        respondentAddress: "0x0000000000000000000000000000000000000003",
        expectedAmountAtto: "1000000000000000000",
      },
    });
    await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "claimant", sessionId: `session-${Math.random()}`, status: "APPROVED" },
    });

    try {
      await assertKycRequirementMet(kase.id);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(KycRequirementNotMetError);
      expect((err as KycRequirementNotMetError).missingRoles).toEqual(["respondent"]);
    }
  });

  it("does NOT block on a non-APPROVED status (e.g. DECLINED, IN_REVIEW)", async () => {
    const kase = await makeCase();
    const integration = await makeIntegration(true);
    await prisma.caseSettlement.create({
      data: {
        caseId: kase.id,
        integrationId: integration.id,
        escrowId: "1",
        claimantAddress: "0x0000000000000000000000000000000000000002",
        respondentAddress: "0x0000000000000000000000000000000000000003",
        expectedAmountAtto: "1000000000000000000",
      },
    });
    await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "claimant", sessionId: `session-${Math.random()}`, status: "DECLINED" },
    });
    await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "respondent", sessionId: `session-${Math.random()}`, status: "APPROVED" },
    });

    await expect(assertKycRequirementMet(kase.id)).rejects.toThrow(/claimant/);
  });

  it("passes when the integration requires KYC and BOTH parties are APPROVED", async () => {
    const kase = await makeCase();
    const integration = await makeIntegration(true);
    await prisma.caseSettlement.create({
      data: {
        caseId: kase.id,
        integrationId: integration.id,
        escrowId: "1",
        claimantAddress: "0x0000000000000000000000000000000000000002",
        respondentAddress: "0x0000000000000000000000000000000000000003",
        expectedAmountAtto: "1000000000000000000",
      },
    });
    await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "claimant", sessionId: `session-${Math.random()}`, status: "APPROVED" },
    });
    await prisma.partyVerification.create({
      data: { caseId: kase.id, role: "respondent", sessionId: `session-${Math.random()}`, status: "APPROVED" },
    });

    await expect(assertKycRequirementMet(kase.id)).resolves.toBeUndefined();
  });
});
