import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { testProviderAdapter, buildTestProviderWebhookPayload } from "@/lib/kyc/test-provider-adapter";
import { personaAdapter } from "@/lib/kyc/persona-adapter";

// Unit coverage for the two "signature over the raw body, reject
// anything unsigned/forged/stale" verification implementations
// underneath /api/kyc/webhook. Replay-dedup itself is a DB-backed
// concern (KycWebhookDelivery's unique constraint) covered in
// tests/integration/kyc-policy-gate.test.ts, not here.

describe("test-provider-adapter.verifyWebhookSignature", () => {
  it("accepts a validly-signed payload and normalizes its status", () => {
    const { rawBody, signature } = buildTestProviderWebhookPayload("test_session_1", "APPROVED");
    const event = testProviderAdapter.verifyWebhookSignature({
      rawBody,
      headers: { "x-test-kyc-signature": signature },
    });
    expect(event.status).toBe("APPROVED");
    expect(event.providerSessionId).toBe("test_session_1");
  });

  it("rejects a forged signature", () => {
    const { rawBody } = buildTestProviderWebhookPayload("test_session_2", "APPROVED");
    const forged = createHmac("sha256", "wrong-secret").update(rawBody).digest("hex");
    expect(() =>
      testProviderAdapter.verifyWebhookSignature({ rawBody, headers: { "x-test-kyc-signature": forged } })
    ).toThrow(/does not match/);
  });

  it("rejects a request with no signature header at all", () => {
    const { rawBody } = buildTestProviderWebhookPayload("test_session_3", "REJECTED");
    expect(() => testProviderAdapter.verifyWebhookSignature({ rawBody, headers: {} })).toThrow(
      /missing X-Test-Kyc-Signature/
    );
  });

  it("rejects a tampered body even with the original signature attached", () => {
    const { rawBody, signature } = buildTestProviderWebhookPayload("test_session_4", "APPROVED");
    const tampered = rawBody.replace("APPROVED", "REJECTED");
    expect(() =>
      testProviderAdapter.verifyWebhookSignature({ rawBody: tampered, headers: { "x-test-kyc-signature": signature } })
    ).toThrow(/does not match/);
  });
});

describe("persona-adapter.verifyWebhookSignature", () => {
  const secret = "persona-test-secret";
  const originalEnv = process.env.PERSONA_WEBHOOK_SECRET;

  function withSecret<T>(fn: () => T): T {
    process.env.PERSONA_WEBHOOK_SECRET = secret;
    try {
      return fn();
    } finally {
      process.env.PERSONA_WEBHOOK_SECRET = originalEnv;
    }
  }

  function samplePayload(status: string) {
    return JSON.stringify({
      data: {
        id: `evt_${status}_${Math.random()}`,
        attributes: {
          name: "inquiry.approved",
          payload: {
            data: {
              id: "inq_abc123",
              type: "inquiry",
              attributes: { status, "reference-id": "party-verification-1" },
            },
          },
        },
      },
    });
  }

  it("accepts a validly-signed webhook (documented t=,v1= scheme)", () =>
    withSecret(() => {
      const rawBody = samplePayload("approved");
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
      const event = personaAdapter.verifyWebhookSignature({
        rawBody,
        headers: { "persona-signature": `t=${t},v1=${sig}` },
      });
      expect(event.status).toBe("APPROVED");
      expect(event.providerSessionId).toBe("inq_abc123");
    }));

  it("rejects a forged signature", () =>
    withSecret(() => {
      const rawBody = samplePayload("approved");
      const t = Math.floor(Date.now() / 1000);
      const forgedSig = createHmac("sha256", "attacker-controlled-secret").update(`${t}.${rawBody}`).digest("hex");
      expect(() =>
        personaAdapter.verifyWebhookSignature({ rawBody, headers: { "persona-signature": `t=${t},v1=${forgedSig}` } })
      ).toThrow(/does not match/);
    }));

  it("rejects a stale timestamp (outside the 5-minute freshness window) even with a correct HMAC for that timestamp", () =>
    withSecret(() => {
      const rawBody = samplePayload("approved");
      const staleT = Math.floor(Date.now() / 1000) - 3600;
      const sig = createHmac("sha256", secret).update(`${staleT}.${rawBody}`).digest("hex");
      expect(() =>
        personaAdapter.verifyWebhookSignature({ rawBody, headers: { "persona-signature": `t=${staleT},v1=${sig}` } })
      ).toThrow(/freshness window/);
    }));

  it("rejects a missing Persona-Signature header", () =>
    withSecret(() => {
      const rawBody = samplePayload("approved");
      expect(() => personaAdapter.verifyWebhookSignature({ rawBody, headers: {} })).toThrow(/missing Persona-Signature/);
    }));
});
