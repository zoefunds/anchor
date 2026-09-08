import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import type {
  KycProviderAdapter,
  NormalizedWebhookEvent,
  VerificationSession,
  VerificationStatusResult,
  WebhookVerificationInput,
} from "@/lib/kyc/provider-adapter";

// NOT A REAL KYC PROVIDER. Simulates a hosted-verification provider's
// PENDING -> APPROVED/REJECTED lifecycle for local dev and tests, with
// no real identity check performed and no real party ever contacted.
// Selecting this adapter outside testnet is refused by lib/kyc/index.ts
// (fail-closed, same posture as environment-registry.ts's
// isTestnetEnvironment gate) — this file has no gating logic of its own
// on purpose, so there is exactly one place that decision is made.

interface SimulatedSession {
  partyVerificationId: string;
  callsSoFar: number;
  forcedStatus?: "APPROVED" | "REJECTED";
}

// Module-level, in-process only — a restart resets every simulated
// session to its initial PENDING state. Fine for local dev/tests, which
// is the only place this adapter may run.
const sessions = new Map<string, SimulatedSession>();

function getWebhookSecret(): string {
  return process.env.KYC_TEST_WEBHOOK_SECRET ?? "test-provider-shared-secret";
}

/** Test-only hook: forces a simulated session straight to a terminal status, used by tests that don't want to poll getVerificationStatus's call-count heuristic. */
export function forceTestProviderStatus(providerSessionId: string, status: "APPROVED" | "REJECTED"): void {
  const existing = sessions.get(providerSessionId);
  if (existing) existing.forcedStatus = status;
}

/** Test-only hook: builds the exact raw body + signature a real webhook delivery for this provider would carry, for tests to POST at the webhook route. */
export function buildTestProviderWebhookPayload(providerSessionId: string, status: "APPROVED" | "REJECTED"): { rawBody: string; signature: string } {
  const body = {
    event_id: `${providerSessionId}-${status}-${Date.now()}`,
    session_id: providerSessionId,
    status,
  };
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", getWebhookSecret()).update(rawBody).digest("hex");
  return { rawBody, signature };
}

export const testProviderAdapter: KycProviderAdapter = {
  name: "test",

  async createVerificationSession(params): Promise<VerificationSession> {
    const providerSessionId = `test_${randomUUID()}`;
    sessions.set(providerSessionId, { partyVerificationId: params.partyVerificationId, callsSoFar: 0 });
    return {
      providerSessionId,
      hostedUrl: `https://kyc-test.local/verify/${providerSessionId}`,
      providerReference: params.partyVerificationId,
    };
  },

  async getVerificationStatus(providerSessionId): Promise<VerificationStatusResult> {
    const session = sessions.get(providerSessionId);
    if (!session) return { status: "NOT_STARTED" };
    if (session.forcedStatus) return { status: session.forcedStatus, providerReference: session.partyVerificationId };
    session.callsSoFar += 1;
    // First poll looks PENDING (mirrors a real hosted flow the party
    // hasn't finished yet); every poll after that "completes" as
    // APPROVED, so a test suite calling this twice sees a real
    // PENDING -> APPROVED transition without needing wall-clock waits.
    return {
      status: session.callsSoFar <= 1 ? "PENDING" : "APPROVED",
      providerReference: session.partyVerificationId,
    };
  },

  verifyWebhookSignature(input: WebhookVerificationInput): NormalizedWebhookEvent {
    const signature = input.headers["x-test-kyc-signature"];
    if (!signature) throw new Error("missing X-Test-Kyc-Signature header");
    const expected = createHmac("sha256", getWebhookSecret()).update(input.rawBody).digest("hex");
    const expectedBuf = Buffer.from(expected, "utf8");
    const actualBuf = Buffer.from(signature, "utf8");
    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      throw new Error("test provider webhook signature does not match");
    }
    const parsed = JSON.parse(input.rawBody) as { event_id: string; session_id: string; status: "APPROVED" | "REJECTED" | "PENDING" };
    return {
      providerEventId: parsed.event_id,
      providerSessionId: parsed.session_id,
      status: parsed.status,
      raw: parsed,
    };
  },
};
