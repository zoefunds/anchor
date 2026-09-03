import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { generatePartyToken } from "@/lib/party-auth";
import { GET as getPublicCase } from "@/app/api/public/cases/[id]/route";
import { POST as postEvidence } from "@/app/api/public/cases/[id]/evidence/route";
import { POST as postSession } from "@/app/api/public/cases/[id]/session/route";

// Exercises the party-token/session auth path (see lib/party-auth.ts)
// against real Postgres and the actual route handlers — the specific
// gap the audit flagged ("no integration test coverage for token
// access"). Deliberately calls the exported route handlers directly
// rather than spinning up an HTTP server: an App Router route handler
// is just an async (Request) => Response function, so this exercises
// the real auth/validation/DB logic without that overhead.

let orgId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "party-token-test-org" } });
  orgId = org.id;
});

afterAll(async () => {
  await prisma.partySession.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.evidence.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  // Real regression this session's own evidence-route audit-logging fix
  // introduced: evidence submission now writes an AuditLog row (see
  // api/public/cases/:id/evidence/route.ts), which this cleanup didn't
  // account for — organization.delete() failed on the FK constraint
  // until this was added. Caught by actually running the suite against
  // a real local Postgres, not by inspection.
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

async function makeCase() {
  const claimant = generatePartyToken();
  const respondent = generatePartyToken();
  const kase = await prisma.case.create({
    data: {
      organizationId: orgId,
      claim: "test_claim",
      amount: 100,
      claimantRef: "A",
      respondentRef: "B",
      policyId: "agent_data_task_v1",
      policyVersion: "1.0.0",
      status: "EVIDENCE_COLLECTION",
      claimantTokenHash: claimant.hash,
      respondentTokenHash: respondent.hash,
      claimantTokenExpiresAt: claimant.expiresAt,
      respondentTokenExpiresAt: respondent.expiresAt,
    },
  });
  return { kase, claimantToken: claimant.raw, respondentToken: respondent.raw };
}

describe("public case read — token access", () => {
  it("rejects a request with no token and no session", async () => {
    const { kase } = await makeCase();
    const req = new NextRequest(`http://test/api/public/cases/${kase.id}`);
    const res = await getPublicCase(req, { params: { id: kase.id } });
    expect(res.status).toBe(401);
  });

  it("accepts a request with the correct claimant token", async () => {
    const { kase, claimantToken } = await makeCase();
    const req = new NextRequest(`http://test/api/public/cases/${kase.id}?token=${claimantToken}`);
    const res = await getPublicCase(req, { params: { id: kase.id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(kase.id);
  });

  it("rejects a token that belongs to a different case", async () => {
    const { kase: caseA } = await makeCase();
    const { claimantToken: tokenB } = await makeCase();
    const req = new NextRequest(`http://test/api/public/cases/${caseA.id}?token=${tokenB}`);
    const res = await getPublicCase(req, { params: { id: caseA.id } });
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const { kase, claimantToken } = await makeCase();
    await prisma.case.update({
      where: { id: kase.id },
      data: { claimantTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    const req = new NextRequest(`http://test/api/public/cases/${kase.id}?token=${claimantToken}`);
    const res = await getPublicCase(req, { params: { id: kase.id } });
    expect(res.status).toBe(401);
  });
});

describe("public evidence submission — role derived from token, not client input", () => {
  it("stamps submittedBy from the resolved role, ignoring any client-supplied value", async () => {
    const { kase, respondentToken } = await makeCase();
    const req = new NextRequest(`http://test/api/public/cases/${kase.id}/evidence`, {
      method: "POST",
      body: JSON.stringify({ token: respondentToken, type: "respondent_statement", content: "it was fine", submittedBy: "claimant" }),
    });
    const res = await postEvidence(req, { params: { id: kase.id } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.submittedBy).toBe("respondent");
  });

  it("rejects an evidence type not defined by the case's policy", async () => {
    const { kase, claimantToken } = await makeCase();
    const req = new NextRequest(`http://test/api/public/cases/${kase.id}/evidence`, {
      method: "POST",
      body: JSON.stringify({ token: claimantToken, type: "not_a_real_type", content: "x" }),
    });
    const res = await postEvidence(req, { params: { id: kase.id } });
    expect(res.status).toBe(400);
  });
});

describe("session exchange — short-lived cookie replaces the long-lived token", () => {
  it("exchanges a valid token for a session cookie, then that cookie alone authenticates", async () => {
    const { kase, claimantToken } = await makeCase();

    const exchangeReq = new NextRequest(`http://test/api/public/cases/${kase.id}/session`, {
      method: "POST",
      body: JSON.stringify({ token: claimantToken }),
    });
    const exchangeRes = await postSession(exchangeReq, { params: { id: kase.id } });
    expect(exchangeRes.status).toBe(200);
    const setCookie = exchangeRes.cookies.get("anchor_party_session");
    expect(setCookie?.value).toBeTruthy();

    // No token in this request at all — only the exchanged cookie.
    const readReq = new NextRequest(`http://test/api/public/cases/${kase.id}`, {
      headers: { cookie: `anchor_party_session=${setCookie!.value}` },
    });
    const readRes = await getPublicCase(readReq, { params: { id: kase.id } });
    expect(readRes.status).toBe(200);
  });

  it("does not let a session minted for one case authenticate a different case", async () => {
    const { kase: caseA, claimantToken: tokenA } = await makeCase();
    const { kase: caseB } = await makeCase();

    const exchangeReq = new NextRequest(`http://test/api/public/cases/${caseA.id}/session`, {
      method: "POST",
      body: JSON.stringify({ token: tokenA }),
    });
    const exchangeRes = await postSession(exchangeReq, { params: { id: caseA.id } });
    const setCookie = exchangeRes.cookies.get("anchor_party_session");

    const readReq = new NextRequest(`http://test/api/public/cases/${caseB.id}`, {
      headers: { cookie: `anchor_party_session=${setCookie!.value}` },
    });
    const readRes = await getPublicCase(readReq, { params: { id: caseB.id } });
    expect(readRes.status).toBe(401);
  });

  it("rejects exchange for an unknown token", async () => {
    const { kase } = await makeCase();
    const exchangeReq = new NextRequest(`http://test/api/public/cases/${kase.id}/session`, {
      method: "POST",
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    const exchangeRes = await postSession(exchangeReq, { params: { id: kase.id } });
    expect(exchangeRes.status).toBe(401);
  });
});
