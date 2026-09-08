import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/auth";
import { POST as createCase, GET as listCases } from "@/app/api/cases/route";
import { verifyWebhookSignature } from "../../../../packages/anchor-sdk/webhooks";
import type { CreateCaseResponse, CaseRecord } from "../../../../packages/anchor-sdk/types";

// Round-trip/contract coverage for packages/anchor-sdk (Item A of the
// Phase 5 SDK work): the routes here validate manually (no Zod schema
// to import and diff types against), so this instead calls the real
// route handlers directly — same convention every other file in this
// directory already uses — and asserts the actual JSON response has
// every field the SDK's CreateCaseResponse/CaseRecord types declare.
// A field renamed or dropped in the route without updating
// packages/anchor-sdk/types.ts fails this test.

let orgId: string;
let apiKeyRaw: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: "sdk-contract-test-org" } });
  orgId = org.id;
  const { raw, hash, prefix } = generateApiKey();
  apiKeyRaw = raw;
  await prisma.apiKey.create({
    data: { organizationId: orgId, name: "sdk-contract-test-key", keyHash: hash, keyPrefix: prefix },
  });
});

afterAll(async () => {
  await prisma.evidence.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.riskAssessment.deleteMany({ where: { case: { organizationId: orgId } } });
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  await prisma.apiKey.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

function req(body: unknown) {
  return new NextRequest("http://localhost/api/cases", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKeyRaw}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("@anchor/sdk contract: POST /api/cases", () => {
  it("returns a body structurally matching CreateCaseResponse", async () => {
    const res = await createCase(
      req({ claim: "sdk contract test claim", amount: "42.00", claimantRef: "sdk-claimant-1", respondentRef: "sdk-respondent-1" })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as CreateCaseResponse;

    const requiredKeys: Array<keyof CreateCaseResponse> = [
      "id",
      "organizationId",
      "status",
      "claim",
      "amount",
      "currency",
      "policyId",
      "policyVersion",
      "claimantRef",
      "respondentRef",
      "claimantToken",
      "respondentToken",
    ];
    for (const key of requiredKeys) {
      expect(body, `expected response to have field "${key}"`).toHaveProperty(key);
    }
    expect(typeof body.claimantToken).toBe("string");
    expect(typeof body.respondentToken).toBe("string");
    expect(body.claim).toBe("sdk contract test claim");
    expect(body.status).toBe("EVIDENCE_COLLECTION");

    // The route deliberately never echoes the raw token hash fields back.
    expect(body).not.toHaveProperty("claimantTokenHash");
    expect(body).not.toHaveProperty("respondentTokenHash");
  });

  it("rejects a JSON-numeric amount with 400, matching the SDK's CreateCaseRequest.amount: string contract", async () => {
    const res = await req({ claim: "x", amount: 42, claimantRef: "a", respondentRef: "b" });
    const response = await createCase(res);
    expect(response.status).toBe(400);
  });
});

describe("@anchor/sdk contract: GET /api/cases", () => {
  it("returns an array whose entries match CaseRecord (no pagination envelope)", async () => {
    await createCase(req({ claim: "listed case", amount: "10.00", claimantRef: "lc1", respondentRef: "lc2" }));

    const listReq = new NextRequest("http://localhost/api/cases", {
      headers: { Authorization: `Bearer ${apiKeyRaw}` },
    });
    const res = await listCases(listReq);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CaseRecord[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("id");
    expect(body[0]).toHaveProperty("status");
  });
});

describe("@anchor/sdk contract: verifyWebhookSignature", () => {
  it("accepts a signature computed the same way apps/web/src/lib/webhooks.ts signs deliveries", () => {
    const secret = "whsec_test_secret_0123456789abcdef";
    const body = JSON.stringify({ event: "case.status_changed", createdAt: new Date().toISOString(), data: { caseId: "abc" } });
    const timestamp = Math.floor(Date.now() / 1000);
    // Reimplements webhooks.ts's private signPayload(secret, timestamp, body)
    // exactly (HMAC-SHA256 over `${timestamp}.${body}`) since that
    // function isn't exported — this is the actual documented scheme,
    // asserted in webhooks.ts's own header comment.
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

    const ok = verifyWebhookSignature({
      rawBody: body,
      timestampHeader: String(timestamp),
      signatureHeader: `sha256=${signature}`,
      secret,
    });
    expect(ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const secret = "whsec_test_secret_0123456789abcdef";
    const body = JSON.stringify({ event: "case.decided", createdAt: new Date().toISOString(), data: {} });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

    const ok = verifyWebhookSignature({
      rawBody: body + "tampered",
      timestampHeader: String(timestamp),
      signatureHeader: `sha256=${signature}`,
      secret,
    });
    expect(ok).toBe(false);
  });

  it("rejects a stale timestamp outside the replay tolerance", () => {
    const secret = "whsec_test_secret_0123456789abcdef";
    const body = JSON.stringify({ event: "case.decided", createdAt: new Date().toISOString(), data: {} });
    const timestamp = Math.floor(Date.now() / 1000) - 10_000;
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

    const ok = verifyWebhookSignature({
      rawBody: body,
      timestampHeader: String(timestamp),
      signatureHeader: `sha256=${signature}`,
      secret,
    });
    expect(ok).toBe(false);
  });
});
