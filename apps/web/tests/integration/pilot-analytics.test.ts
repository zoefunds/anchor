import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Track 4 item 3 coverage: the two genuinely new metrics
// (evidenceCompletionRate, settlementRetryRate) added to
// computeOrgAnalytics, and the new pilot-report export endpoint (JSON
// + CSV shape). Runs against a real local Postgres, same pattern as
// tests/integration/case-settlement.test.ts.

const { prisma } = await import("@/lib/prisma");
const { computeOrgAnalytics } = await import("@/lib/analytics");
const { GET: pilotReportGet } = await import("@/app/api/organizations/pilot-report/route");

let orgId: string;
let apiKeyToken: string;
const caseIds: string[] = [];
const integrationIds: string[] = [];
const policyIds: string[] = [];

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "pilot-analytics-test-org" } });
  orgId = org.id;

  const { createHash, randomBytes } = await import("crypto");
  const raw = randomBytes(24).toString("hex");
  apiKeyToken = raw;
  await prisma.apiKey.create({
    data: {
      organizationId: orgId,
      name: "pilot-analytics-test-key",
      keyHash: createHash("sha256").update(raw).digest("hex"),
      keyPrefix: raw.slice(0, 8),
      scopes: ["analytics:read"],
    },
  });
});

afterEach(async () => {
  await prisma.decision.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.evidence.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.caseSettlement.deleteMany({ where: { caseId: { in: caseIds } } });
  await prisma.case.deleteMany({ where: { id: { in: caseIds } } });
  await prisma.settlementIntegration.deleteMany({ where: { id: { in: integrationIds } } });
  await prisma.policyVersion.deleteMany({ where: { policyId: { in: policyIds } } });
  await prisma.policy.deleteMany({ where: { id: { in: policyIds } } });
  caseIds.length = 0;
  integrationIds.length = 0;
  policyIds.length = 0;
});

afterAll(async () => {
  await prisma.apiKey.deleteMany({ where: { organizationId: orgId } });
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
});

async function makePolicyVersion(evidenceDeadlineHours: number) {
  const policy = await prisma.policy.create({
    data: { organizationId: orgId, key: `pilot-test-${Date.now()}-${Math.random()}`, name: "pilot test policy" },
  });
  policyIds.push(policy.id);
  const pv = await prisma.policyVersion.create({
    data: {
      policyId: policy.id,
      version: 1,
      evidenceDeadlineHours,
      appealWindowHours: 24,
      allowedOutcomes: ["CLAIMANT_WINS", "RESPONDENT_WINS"],
      allowedAssets: ["USDC"],
      allowedChains: ["sepolia"],
      velocityLimits: {},
      humanReviewTriggers: {},
    },
  });
  return { policy, pv };
}

async function makeIntegration() {
  const integration = await prisma.settlementIntegration.create({
    data: {
      organizationId: orgId,
      chain: "sepolia",
      escrowContractAddress: "0x" + "1".repeat(40),
      assetSymbol: "USDC",
      assetDecimals: 6,
      createdByMemberId: "test-member",
    },
  });
  integrationIds.push(integration.id);
  return integration;
}

describe("evidence completion rate", () => {
  it("counts only cases past their evidence deadline, requiring both parties", async () => {
    const { pv } = await makePolicyVersion(1); // 1 hour deadline — safely in the past for a case created "now"

    const complete = await prisma.case.create({
      data: {
        organizationId: orgId,
        claim: "complete",
        amount: "1",
        claimantRef: "c1",
        respondentRef: "r1",
        policyId: pv.policyId,
        policyVersion: String(pv.version),
        policyVersionRecordId: pv.id,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    caseIds.push(complete.id);
    await prisma.evidence.create({
      data: { caseId: complete.id, type: "text", contentHash: "h1", storageRef: "s1", submittedBy: "claimant" },
    });
    await prisma.evidence.create({
      data: { caseId: complete.id, type: "text", contentHash: "h2", storageRef: "s2", submittedBy: "respondent" },
    });

    const incomplete = await prisma.case.create({
      data: {
        organizationId: orgId,
        claim: "incomplete",
        amount: "1",
        claimantRef: "c2",
        respondentRef: "r2",
        policyId: pv.policyId,
        policyVersion: String(pv.version),
        policyVersionRecordId: pv.id,
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    caseIds.push(incomplete.id);
    await prisma.evidence.create({
      data: { caseId: incomplete.id, type: "text", contentHash: "h3", storageRef: "s3", submittedBy: "claimant" },
    });

    const notYetDue = await prisma.case.create({
      data: {
        organizationId: orgId,
        claim: "not due yet",
        amount: "1",
        claimantRef: "c3",
        respondentRef: "r3",
        policyId: pv.policyId,
        policyVersion: String(pv.version),
        policyVersionRecordId: pv.id,
      },
    });
    caseIds.push(notYetDue.id);

    const result = await computeOrgAnalytics(orgId, 1);
    expect(result.disputeCount).toBe(3);
    // 1 of 2 due cases has both parties => 0.5. The not-yet-due case is excluded from the denominator.
    expect(result.evidenceCompletionRate).toBeCloseTo(0.5);
  });
});

describe("settlement retry rate", () => {
  it("flags settled cases that needed more than one relay attempt", async () => {
    const { pv } = await makePolicyVersion(999999);
    const integration = await makeIntegration();

    async function makeSettledCase(relayAttempts: number) {
      const kase = await prisma.case.create({
        data: {
          organizationId: orgId,
          claim: "settled",
          amount: "1",
          claimantRef: "c",
          respondentRef: "r",
          policyId: pv.policyId,
          policyVersion: String(pv.version),
          policyVersionRecordId: pv.id,
          status: "FINALIZED",
        },
      });
      caseIds.push(kase.id);
      await prisma.caseSettlement.create({
        data: {
          caseId: kase.id,
          integrationId: integration.id,
          escrowId: "0x" + kase.id.padEnd(40, "0").slice(0, 40),
          expectedAmountAtto: "1000000",
        },
      });
      await prisma.decision.create({
        data: {
          caseId: kase.id,
          policyId: pv.policyId,
          policyVersion: String(pv.version),
          outcome: "CLAIMANT_WINS",
          consensus: "unanimous",
          relayTxHash: "0x" + "a".repeat(64),
          relayAttempts,
        },
      });
      return kase;
    }

    await makeSettledCase(1);
    await makeSettledCase(2);
    await makeSettledCase(3);

    const result = await computeOrgAnalytics(orgId, 1);
    // 2 of 3 settled cases needed >1 attempt
    expect(result.settlementRetryRate).toBeCloseTo(2 / 3);
    expect(result.avgRelayAttempts).toBeCloseTo(2);
    expect(result.byIntegration[integration.id].settlementRetryRate).toBeCloseTo(2 / 3);
  });
});

describe("GET /api/organizations/pilot-report", () => {
  it("returns a consolidated JSON report", async () => {
    const req = new NextRequest(`https://example.test/api/organizations/pilot-report?period=${currentPeriod()}`, {
      headers: { Authorization: `Bearer ${apiKeyToken}` },
    });
    const res = await pilotReportGet(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organizationId).toBe(orgId);
    expect(typeof body.disputeIntakeVolume).toBe("number");
    expect(typeof body.evidenceCompletionRate).toBe("number");
    expect(typeof body.settlementRetryRate).toBe("number");
    expect(body).toHaveProperty("byIntegration");
    expect(body).toHaveProperty("byPolicy");
  });

  it("returns a flattened CSV report", async () => {
    const req = new NextRequest(`https://example.test/api/organizations/pilot-report?period=${currentPeriod()}&format=csv`, {
      headers: { Authorization: `Bearer ${apiKeyToken}` },
    });
    const res = await pilotReportGet(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\n")[0]).toBe("section,key,value");
    expect(text).toContain("summary,disputeIntakeVolume,");
  });

  it("rejects an invalid format", async () => {
    const req = new NextRequest("https://example.test/api/organizations/pilot-report?format=xml", {
      headers: { Authorization: `Bearer ${apiKeyToken}` },
    });
    const res = await pilotReportGet(req);
    expect(res.status).toBe(400);
  });
});

function currentPeriod() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
