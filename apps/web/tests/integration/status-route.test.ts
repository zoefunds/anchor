import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { GET as getStatus } from "@/app/api/status/route";

// Phase 5, last item: GET /api/status is public and unauthenticated —
// unlike every other route in this directory, there is no auth check
// standing between "a bug in this handler" and "the whole internet
// sees it". This test creates fixtures that WOULD leak (an org-scoped
// incident, a case, a decision with a real relay tx hash) and asserts
// none of it appears in the actual JSON the route handler returns —
// calling the handler directly, not just reading the source.

let orgId: string;
let caseId: string;
let decisionId: string;
let orgIncidentId: string;
let globalIncidentId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "status-route-test-org" } });
  orgId = org.id;

  orgIncidentId = (
    await prisma.incident.create({
      data: {
        organizationId: orgId,
        title: "org-scoped-incident-must-not-leak",
        description: "should never appear on the public status page",
        status: "INVESTIGATING",
      },
    })
  ).id;

  globalIncidentId = (
    await prisma.incident.create({
      data: {
        organizationId: null,
        title: "global-incident-should-appear",
        description: "platform-wide, safe to publish",
        status: "MONITORING",
      },
    })
  ).id;

  const caseRecord = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim: "status-route-test-case",
      amount: "10.00",
      policyId: "test-policy",
      policyVersion: "1",
      claimantRef: "claimant-ref",
      respondentRef: "respondent-ref",
    },
  });
  caseId = caseRecord.id;

  const decision = await prisma.decision.create({
    data: {
      caseId,
      policyId: "test-policy",
      policyVersion: "1",
      outcome: "claimant_favored",
      consensus: "unanimous",
      relayTxHash: "0xdeadbeefsecretshouldnotleak",
    },
  });
  decisionId = decision.id;
});

afterAll(async () => {
  await prisma.decision.deleteMany({ where: { caseId } });
  await prisma.case.deleteMany({ where: { id: caseId } });
  await prisma.incident.deleteMany({ where: { id: { in: [orgIncidentId, globalIncidentId] } } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("GET /api/status", () => {
  it("never includes org-scoped incidents, case/decision ids, tx hashes, or connection strings", async () => {
    const res = await getStatus();
    const raw = await res.text();
    const body = JSON.parse(raw);

    expect(res.status).toBeLessThan(500);

    expect(raw).not.toContain(orgId);
    expect(raw).not.toContain(caseId);
    expect(raw).not.toContain(decisionId);
    expect(raw).not.toContain("0xdeadbeefsecretshouldnotleak");
    expect(raw).not.toContain("org-scoped-incident-must-not-leak");

    expect(raw).not.toMatch(/postgres:\/\//i);
    expect(raw).not.toMatch(/rediss?:\/\//i);
    expect(raw).not.toContain(process.env.DATABASE_URL ?? "__no_database_url__");
    expect(raw).not.toContain(process.env.REDIS_URL ?? "__no_redis_url__");

    const titles = (body.incidents ?? []).map((i: { title: string }) => i.title);
    expect(titles).not.toContain("org-scoped-incident-must-not-leak");
    expect(titles).toContain("global-incident-should-appear");

    expect(body).toHaveProperty("environment");
    expect(body).toHaveProperty("components");
    expect(body.components).not.toHaveProperty("db");
    for (const key of Object.keys(body.components)) {
      expect(["up", "degraded", "down"]).toContain(body.components[key]);
    }
    if (body.canary) {
      expect(body.canary).not.toHaveProperty("detail");
      expect(body.canary).not.toHaveProperty("relayTxHash");
      expect(Object.keys(body.canary).sort()).toEqual(["lastRunAt", "outcome"]);
    }
  });

  it("never leaks a stack trace even when an internal call throws", async () => {
    const original = prisma.canaryRun.findFirst;
    prisma.canaryRun.findFirst = (async () => {
      throw new Error(`connection to postgres://postgres:secret@169.155.55.120:5432/anchor failed`);
    }) as typeof prisma.canaryRun.findFirst;
    try {
      const res = await getStatus();
      const raw = await res.text();
      expect(raw).not.toMatch(/postgres:\/\//i);
      expect(raw).not.toContain("secret");
      expect(raw).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // no stack-trace-shaped line
    } finally {
      prisma.canaryRun.findFirst = original;
    }
  });
});
