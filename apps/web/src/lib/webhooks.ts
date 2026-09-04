import { createHmac, randomBytes, createCipheriv, createDecipheriv } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdjudicationQueue } from "@/lib/queue";
import { assertSafeToFetch, safeFetch } from "@/lib/ssrf-guard";

// --- Webhook secret encryption at rest ---
// Real P1 fixed here (external audit finding, raised twice): webhook
// signing secrets used to be stored as plaintext (Webhook.secret) and
// returned in full on every GET /api/webhooks — anyone with read access
// to the database, or a backup/replica, or the API response itself
// (before this fix, a real signing secret leaves the server on every
// listing) could recover the exact secret used to authenticate webhook
// deliveries. Encrypted at rest with AES-256-GCM below; the raw secret
// is now only ever returned once, at creation or rotation — see the
// GET/POST handlers and the new rotate-secret route. This is envelope
// encryption in spirit (a data-encryption key derived from one root
// secret held outside the database) but not a real KMS — the audit's
// suggested next step, a managed KMS with per-secret data keys and key
// rotation, is a real, larger follow-up this does not attempt.
function getWebhookSecretEncryptionKey(): Buffer {
  const hex = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEY is not set — see apps/web/.env.example");
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEY must be 32 bytes (64 hex chars) for AES-256-GCM");
  }
  return key;
}

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export function encryptWebhookSecret(secret: string): EncryptedSecret {
  const iv = randomBytes(12); // GCM standard IV size
  const cipher = createCipheriv("aes-256-gcm", getWebhookSecretEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("hex"), iv: iv.toString("hex"), authTag: cipher.getAuthTag().toString("hex") };
}

export function decryptWebhookSecret(enc: EncryptedSecret): string {
  const decipher = createDecipheriv("aes-256-gcm", getWebhookSecretEncryptionKey(), Buffer.from(enc.iv, "hex"));
  decipher.setAuthTag(Buffer.from(enc.authTag, "hex"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(enc.ciphertext, "hex")), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Display-only, never the real secret — same masking convention as API keys' keyPrefix. */
export function webhookSecretPreview(rawSecret: string): string {
  return `${rawSecret.slice(0, 11)}...`; // "whsec_" + 5 hex chars, matches ak_live_'s display length
}

// Fixed vocabulary, enforced in application code (not the DB schema,
// which stores events as a plain string array) - keep this in sync with
// the SKILL.md doc and anywhere a caller subscribes.
export const WEBHOOK_EVENTS = [
  "case.status_changed",
  "case.decided",
  "case.appealed",
  "case.relay_dispatched",
  // Priority 3 (settlement-readiness gaps, item 9 — respondent
  // notification): Anchor doesn't hold party email addresses (only
  // opaque claimantRef/respondentRef strings and EVM payout
  // addresses), so a real per-party email notification isn't
  // buildable with what this system actually stores. What IS real
  // and already wired: notifying the ORGANIZATION'S OWN registered
  // webhook subscribers, who are expected to relay this to their
  // respondent however they already contact parties. See
  // api/cases/[id]/emergency-refund/prepare/route.ts (requested) and
  // lib/reconciliation.ts's checkEmergencyRefundsSettled (settled).
  "case.emergency_refund_requested",
  "case.emergency_refund_settled",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

/**
 * Signature covers `${timestamp}.${body}`, not just the body — same
 * scheme as Stripe's webhook signing. A signature over the body alone
 * has no freshness marker at all: a captured valid (signature, body)
 * pair stays "valid" forever and can be replayed against the receiver
 * indefinitely. Including a delivery-attempt timestamp in what's signed
 * lets a receiver reject anything outside a reasonable window (a few
 * minutes) as a replay, the same way it should already be rejecting a
 * request with no signature at all.
 */
function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * Fires one event to every active webhook an org has subscribed for it.
 * Enqueues one real BullMQ job per webhook (durable, retried with
 * backoff on failure - see lib/worker.ts's "deliver_webhook" handler),
 * not a fire-and-forget fetch. Never await this in a request handler -
 * enqueueing is fast, but delivery itself (including retries) must not
 * block the case-status transition that triggered it.
 */
export function dispatchWebhookEvent(params: {
  organizationId: string;
  event: WebhookEvent;
  data: Record<string, unknown>;
}): void {
  void (async () => {
    const webhooks = await prisma.webhook.findMany({
      where: { organizationId: params.organizationId, active: true, events: { has: params.event } },
    });

    const payload = {
      event: params.event,
      createdAt: new Date().toISOString(),
      data: params.data,
    };

    await Promise.all(
      webhooks.map((webhook) =>
        getAdjudicationQueue().add(
          "deliver_webhook",
          { webhookId: webhook.id, payload },
          { attempts: 5, backoff: { type: "exponential", delay: 10_000 } }
        )
      )
    );
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("webhook dispatch enqueue failed:", err instanceof Error ? err.message : err);
  });
}

/**
 * Actually delivers one webhook attempt - called by lib/worker.ts's
 * "deliver_webhook" job handler, not directly. Re-validates the URL
 * against SSRF right before fetching (not just at registration - DNS
 * can change between the two), and always records a WebhookDelivery row
 * so the org can see every attempt (including ones BullMQ will retry),
 * not just the final outcome.
 *
 * Throws on failure so BullMQ's own retry/backoff takes over - a caught-
 * and-swallowed error here would silently turn "retry with backoff" into
 * "try once."
 */
export async function deliverWebhookAttempt(webhookId: string, payload: {
  event: string;
  createdAt: string;
  data: Record<string, unknown>;
}): Promise<void> {
  const webhook = await prisma.webhook.findUnique({ where: { id: webhookId } });
  if (!webhook || !webhook.active) return; // deleted/deactivated since this was enqueued - nothing to do

  const body = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);

  try {
    await assertSafeToFetch(webhook.url);
  } catch (err) {
    // A webhook whose URL now resolves somewhere private (registered
    // safely, DNS repointed since) is a config problem the org needs to
    // fix, not something to retry into - retrying an SSRF-blocked URL 5
    // times doesn't help anyone.
    const message = err instanceof Error ? err.message : String(err);
    await prisma.webhookDelivery.create({
      data: { webhookId: webhook.id, event: payload.event, payload: payload as Prisma.InputJsonValue, responseStatus: null, error: message },
    });
    return;
  }

  // secretCiphertext/secretIv/secretAuthTag are required columns as of
  // prisma/migrations/20260902200000_webhook_secrets_not_null — every
  // row is guaranteed to have them, so no defensive null-check here.
  const secret = decryptWebhookSecret({ ciphertext: webhook.secretCiphertext, iv: webhook.secretIv, authTag: webhook.secretAuthTag });
  const signature = signPayload(secret, timestamp, body);
  let responseStatus: number | null = null;
  let error: string | null = null;
  try {
    const res = await safeFetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Anchor-Event": payload.event,
        "X-Anchor-Timestamp": String(timestamp),
        "X-Anchor-Signature": `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    responseStatus = res.status;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  await prisma.webhookDelivery.create({
    data: {
      webhookId: webhook.id,
      event: payload.event,
      payload: payload as Prisma.InputJsonValue,
      responseStatus,
      error,
    },
  });

  // A non-2xx or network error should count as a failed delivery attempt
  // as far as BullMQ's retry logic is concerned - only a real error
  // triggers its backoff/retry.
  if (error) {
    throw new Error(error);
  }
  if (responseStatus !== null && (responseStatus < 200 || responseStatus >= 300)) {
    throw new Error(`webhook endpoint responded ${responseStatus}`);
  }
}
