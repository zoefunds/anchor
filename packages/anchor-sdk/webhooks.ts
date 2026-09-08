import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verifies an inbound Anchor webhook delivery. Matches
 * apps/web/src/lib/webhooks.ts's signPayload/deliverWebhookAttempt
 * exactly: HMAC-SHA256 over `${timestamp}.${rawBody}` using the raw
 * (decrypted) webhook secret, sent as headers
 * `X-Anchor-Timestamp` and `X-Anchor-Signature: sha256=<hex>`.
 *
 * `rawBody` must be the exact bytes Anchor sent (before any
 * JSON.parse/re-stringify on the receiving end) — HMACs aren't
 * stable across re-serialization.
 */
export function verifyWebhookSignature(params: {
  rawBody: string;
  timestampHeader: string | null;
  signatureHeader: string | null;
  secret: string;
  /** Reject deliveries older than this many seconds (replay protection). Default 300s, matching the signing scheme's own stated purpose. */
  toleranceSeconds?: number;
}): boolean {
  const { rawBody, timestampHeader, signatureHeader, secret, toleranceSeconds = 300 } = params;
  if (!timestampHeader || !signatureHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const match = /^sha256=([0-9a-f]+)$/.exec(signatureHeader);
  if (!match) return false;
  const providedHex = match[1];

  const expectedHex = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(providedHex, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
