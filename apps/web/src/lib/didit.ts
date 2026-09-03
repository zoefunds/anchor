import { createHmac, timingSafeEqual } from "crypto";

// Didit (https://docs.didit.me/) — KYC/KYB identity verification and
// sanctions/PEP screening. Free tier: 500 verifications/month. See
// apps/web/.env.example for DIDIT_API_KEY/DIDIT_WORKFLOW_ID/
// DIDIT_WEBHOOK_SECRET.

const DIDIT_API_BASE = "https://verification.didit.me";

function getApiKey(): string {
  const key = process.env.DIDIT_API_KEY;
  if (!key) throw new Error("DIDIT_API_KEY is not set — see apps/web/.env.example");
  return key;
}

function getWorkflowId(): string {
  const id = process.env.DIDIT_WORKFLOW_ID;
  if (!id) throw new Error("DIDIT_WORKFLOW_ID is not set — see apps/web/.env.example");
  return id;
}

// Each webhook DESTINATION gets its own signing secret (confirmed live:
// the sandbox app's destination and the live app's destination are
// separate secrets, even pointing at the same URL) — so a deployment
// that receives webhooks from both a live and a sandbox Didit
// application (as this one does, for real end-to-end testing with
// synthetic data before ever touching a live session) needs to try
// more than one secret. DIDIT_WEBHOOK_SECRET_SANDBOX is optional; when
// unset, only the live secret is checked, unchanged from before this.
function getWebhookSecrets(): string[] {
  const live = process.env.DIDIT_WEBHOOK_SECRET;
  if (!live) throw new Error("DIDIT_WEBHOOK_SECRET is not set — see apps/web/.env.example");
  const sandbox = process.env.DIDIT_WEBHOOK_SECRET_SANDBOX;
  return sandbox ? [live, sandbox] : [live];
}

export interface DiditSession {
  session_id: string;
  session_number: number;
  session_token: string;
  url: string;
  vendor_data: string | null;
  status: string;
  workflow_id: string;
  workflow_version: number;
  callback: string | null;
}

/**
 * Starts a new Didit verification session for `vendorData` (Anchor's
 * own PartyVerification.id, echoed back in webhooks for correlation —
 * see resolvePartyVerificationWebhook below) and returns the hosted
 * URL to redirect the party to. Real POST /v3/session/ call, not
 * mocked — see https://docs.didit.me/integration/api-full-flow.
 */
export async function createDiditSession(params: { vendorData: string; callbackUrl: string }): Promise<DiditSession> {
  const res = await fetch(`${DIDIT_API_BASE}/v3/session/`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": getApiKey() },
    body: JSON.stringify({
      workflow_id: getWorkflowId(),
      callback: params.callbackUrl,
      vendor_data: params.vendorData,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Didit session creation failed: HTTP ${res.status} ${body}`);
  }
  return res.json();
}

/** GET /v3/session/{id}/decision/ — used for reconciliation/backfill, not the primary real-time path (that's the webhook). */
export async function getDiditDecision(sessionId: string): Promise<unknown> {
  const res = await fetch(`${DIDIT_API_BASE}/v3/session/${sessionId}/decision/`, {
    headers: { "x-api-key": getApiKey() },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Didit decision fetch failed: HTTP ${res.status} ${body}`);
  }
  return res.json();
}

// --- Webhook signature verification (X-Signature-V2) ---
// Real security boundary: without this, anything POSTed to the webhook
// route would be trusted as a genuine Didit verification result — an
// attacker could forge an "Approved" decision for any vendor_data.
// Algorithm and canonicalization rules copied exactly from Didit's own
// docs (https://docs.didit.me/integration/api-full-flow's webhook
// section) — this must match byte-for-byte, not "close enough":
// whole-valued floats shortened to ints, object keys sorted
// recursively, compact JSON separators, HMAC-SHA256, constant-time
// compare, and a 5-minute timestamp freshness window to reject replay.

function shortenFloats(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(shortenFloats);
  if (data !== null && typeof data === "object") {
    return Object.fromEntries(Object.entries(data as Record<string, unknown>).map(([key, value]) => [key, shortenFloats(value)]));
  }
  if (typeof data === "number" && Number.isFinite(data) && Number.isInteger(data)) {
    // JS doesn't distinguish 1.0 from 1 the way Python's json module
    // does, so this is naturally a no-op for JSON.parse'd numbers —
    // kept as its own function anyway to mirror Didit's documented
    // algorithm exactly (their reference implementation is Python,
    // where int/float ARE distinct types) rather than assume the JS
    // and Python behaviors coincide without saying so.
    return data;
  }
  return data;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export class DiditWebhookVerificationError extends Error {}

/**
 * Verifies an inbound Didit webhook's X-Signature-V2 header against
 * the raw request body. Throws DiditWebhookVerificationError (never
 * returns false silently) so a caller can't accidentally ignore a
 * failed check — the caller must catch or propagate, not just check a
 * boolean it might forget to test.
 */
export function verifyDiditWebhookSignature(params: { rawBody: string; signatureV2: string; timestamp: string }): void {
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(params.timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) {
    throw new DiditWebhookVerificationError(`webhook timestamp outside the 5-minute freshness window (now=${now}, timestamp=${params.timestamp})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(params.rawBody);
  } catch (err) {
    throw new DiditWebhookVerificationError(`webhook body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const canonical = JSON.stringify(sortKeysDeep(shortenFloats(parsed)));
  const actualBuf = Buffer.from(params.signatureV2, "utf8");

  // Try every configured secret (live, and sandbox if set) — each
  // Didit application/destination has its own, so this is the only way
  // to accept webhooks from more than one without knowing in advance
  // which environment sent a given request. A match against ANY
  // configured secret is accepted; matching none is a real failure.
  const matched = getWebhookSecrets().some((secret) => {
    const expected = createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
    const expectedBuf = Buffer.from(expected, "utf8");
    return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
  });
  if (!matched) {
    throw new DiditWebhookVerificationError("webhook signature does not match any configured secret — refusing to trust this payload");
  }
}
