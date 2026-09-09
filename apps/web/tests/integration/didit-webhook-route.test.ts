import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { prisma } from "@/lib/prisma";
import { POST as diditWebhook } from "@/app/api/webhooks/didit/route";

// Real end-to-end coverage of the webhook route itself (not just the
// signature-verification function in isolation) -- proves a genuine
// signed request actually updates the right PartyVerification row via
// vendor_data correlation, and that the audit log gets a real entry.

const TEST_SECRET = "integration-test-webhook-secret";
const ORIGINAL_SECRET = process.env.DIDIT_WEBHOOK_SECRET;

let orgId: string;
let caseId: string;

beforeAll(async () => {
  process.env.DIDIT_WEBHOOK_SECRET = TEST_SECRET;
  const org = await prisma.organization.create({ data: { name: "didit-webhook-test-org" } });
  orgId = org.id;
  const kase = await prisma.case.create({
    data: { organizationId: orgId, claim: "test claim", amount: "50", claimantRef: "C1", respondentRef: "R1", policyId: "agent_data_task_v1", policyVersion: "1.0.0" },
  });
  caseId = kase.id;
});

afterAll(async () => {
  process.env.DIDIT_WEBHOOK_SECRET = ORIGINAL_SECRET;
  await prisma.partyVerification.deleteMany({ where: { caseId } });
  await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
  // Track 5's KYC_SANCTIONS escalation trigger can open a CaseReview for
  // a declined verification — its FK on Case must be cleared first, or
  // case.deleteMany below fails closed on CaseReview_caseId_fkey.
  await prisma.caseReviewApproval.deleteMany({ where: { review: { caseId } } });
  await prisma.caseReviewNote.deleteMany({ where: { review: { caseId } } });
  await prisma.caseReview.deleteMany({ where: { caseId } });
  await prisma.case.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

function sign(body: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === "object") {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sortKeys((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return createHmac("sha256", TEST_SECRET).update(JSON.stringify(sortKeys(body)), "utf8").digest("hex");
}

function makeRequest(body: unknown, overrideSig?: string) {
  const rawBody = JSON.stringify(body);
  const signatureV2 = overrideSig ?? sign(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("http://localhost/api/webhooks/didit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature-v2": signatureV2, "x-timestamp": timestamp },
    body: rawBody,
  });
}

describe("POST /api/webhooks/didit", () => {
  let verificationId: string;

  beforeEach(async () => {
    // caseId+role is unique, and each test needs a fresh IN_PROGRESS
    // row of its own -- clear whatever the previous test left behind
    // first (a real bug in this test file's own first draft: without
    // this, every test after the first hit a unique-constraint
    // violation here, not in the route under test).
    await prisma.partyVerification.deleteMany({ where: { caseId } });
    const pv = await prisma.partyVerification.create({
      data: { caseId, role: "claimant", sessionId: `pending-${crypto.randomUUID()}`, status: "IN_PROGRESS" },
    });
    verificationId = pv.id;
  });

  it("rejects a request with no signature headers", async () => {
    const req = new Request("http://localhost/api/webhooks/didit", { method: "POST", body: "{}" });
    const res = await diditWebhook(req as never);
    expect(res.status).toBe(400);
  });

  it("rejects a request with an invalid signature", async () => {
    const req = makeRequest({ webhook_type: "status.updated", vendor_data: verificationId, status: "Approved" }, "0".repeat(64));
    const res = await diditWebhook(req as never);
    expect(res.status).toBe(401);
    const row = await prisma.partyVerification.findUniqueOrThrow({ where: { id: verificationId } });
    expect(row.status).toBe("IN_PROGRESS"); // unchanged
  });

  it("updates the correct PartyVerification row on a validly-signed Approved status", async () => {
    const req = makeRequest({
      webhook_type: "status.updated",
      session_id: "real-session-id-123",
      vendor_data: verificationId,
      status: "Approved",
      decision: { id_verifications: [{ status: "Approved" }] },
    });
    const res = await diditWebhook(req as never);
    expect(res.status).toBe(200);

    const row = await prisma.partyVerification.findUniqueOrThrow({ where: { id: verificationId } });
    expect(row.status).toBe("APPROVED");
    expect(row.sessionId).toBe("real-session-id-123");
    expect(row.decision).toEqual({ id_verifications: [{ status: "Approved" }] });
  });

  it("writes an audit log entry for the status change", async () => {
    const req = makeRequest({ webhook_type: "status.updated", vendor_data: verificationId, status: "Declined" });
    await diditWebhook(req as never);

    const entry = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: "party_verification.status_updated", targetId: verificationId } });
    expect(entry).not.toBeNull();
  });

  it("ignores an unknown vendor_data without throwing", async () => {
    const req = makeRequest({ webhook_type: "status.updated", vendor_data: "does-not-exist", status: "Approved" });
    const res = await diditWebhook(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.warning).toBeDefined();
  });

  it("ignores a non-status.updated event type without touching any row", async () => {
    const req = makeRequest({ webhook_type: "data.updated", vendor_data: verificationId, status: "Approved" });
    const res = await diditWebhook(req as never);
    expect(res.status).toBe(200);
    const row = await prisma.partyVerification.findUniqueOrThrow({ where: { id: verificationId } });
    expect(row.status).toBe("IN_PROGRESS"); // unchanged
  });
});
