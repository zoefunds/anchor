import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "crypto";
import { verifyDiditWebhookSignature, DiditWebhookVerificationError } from "@/lib/didit";

// Real regression coverage for the Didit webhook signature check —
// without this, any POST to /api/webhooks/didit would be trusted as a
// genuine verification result. Computes the exact canonical-JSON HMAC
// Didit's own docs specify (sorted keys, compact separators) to prove
// this implementation matches their algorithm, not just "some HMAC".

const TEST_SECRET = "test-webhook-secret-not-real";
const ORIGINAL_SECRET = process.env.DIDIT_WEBHOOK_SECRET;

beforeAll(() => {
  process.env.DIDIT_WEBHOOK_SECRET = TEST_SECRET;
});

afterAll(() => {
  process.env.DIDIT_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

function sign(body: unknown, secret = TEST_SECRET): string {
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
  const canonical = JSON.stringify(sortKeys(body));
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

describe("verifyDiditWebhookSignature", () => {
  it("accepts a correctly-signed, fresh payload", () => {
    const body = { session_id: "abc-123", status: "Approved", vendor_data: "pv_1", zebra: 1, apple: 2 };
    const rawBody = JSON.stringify(body);
    const signatureV2 = sign(body);
    const timestamp = String(Math.floor(Date.now() / 1000));

    expect(() => verifyDiditWebhookSignature({ rawBody, signatureV2, timestamp })).not.toThrow();
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const body = { session_id: "abc-123", status: "Approved" };
    const signatureV2 = sign(body);
    const tamperedRawBody = JSON.stringify({ session_id: "abc-123", status: "Declined" });
    const timestamp = String(Math.floor(Date.now() / 1000));

    expect(() => verifyDiditWebhookSignature({ rawBody: tamperedRawBody, signatureV2, timestamp })).toThrow(DiditWebhookVerificationError);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = { session_id: "abc-123", status: "Approved" };
    const rawBody = JSON.stringify(body);
    const signatureV2 = sign(body, "wrong-secret");
    const timestamp = String(Math.floor(Date.now() / 1000));

    expect(() => verifyDiditWebhookSignature({ rawBody, signatureV2, timestamp })).toThrow(DiditWebhookVerificationError);
  });

  it("rejects a stale timestamp (older than 5 minutes)", () => {
    const body = { session_id: "abc-123", status: "Approved" };
    const rawBody = JSON.stringify(body);
    const signatureV2 = sign(body);
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 400);

    expect(() => verifyDiditWebhookSignature({ rawBody, signatureV2, timestamp: staleTimestamp })).toThrow(DiditWebhookVerificationError);
  });

  it("rejects a timestamp too far in the future (clock-skew abuse)", () => {
    const body = { session_id: "abc-123", status: "Approved" };
    const rawBody = JSON.stringify(body);
    const signatureV2 = sign(body);
    const futureTimestamp = String(Math.floor(Date.now() / 1000) + 400);

    expect(() => verifyDiditWebhookSignature({ rawBody, signatureV2, timestamp: futureTimestamp })).toThrow(DiditWebhookVerificationError);
  });

  it("is insensitive to key order in the source object (canonical sorting)", () => {
    // Same logical payload, different key order -- JSON.stringify of
    // the raw body (as Didit actually sends it) may not match our
    // signing helper's own key order, but the canonical (sorted) form
    // must still verify correctly either way.
    const bodyA = { b: 2, a: 1 };
    const rawBodyA = JSON.stringify(bodyA);
    const signatureV2 = sign(bodyA); // signed over the SORTED canonical form
    const timestamp = String(Math.floor(Date.now() / 1000));

    // rawBodyA itself is NOT in sorted order (b before a), but
    // verification re-sorts before hashing, so it must still pass.
    expect(() => verifyDiditWebhookSignature({ rawBody: rawBodyA, signatureV2, timestamp })).not.toThrow();
  });

  it("rejects malformed (non-JSON) body", () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(() => verifyDiditWebhookSignature({ rawBody: "not json", signatureV2: "deadbeef", timestamp })).toThrow(DiditWebhookVerificationError);
  });
});
