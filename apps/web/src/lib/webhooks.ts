import { createHmac, randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Fixed vocabulary, enforced in application code (not the DB schema,
// which stores events as a plain string array) - keep this in sync with
// the SKILL.md doc and anywhere a caller subscribes.
export const WEBHOOK_EVENTS = [
  "case.status_changed",
  "case.decided",
  "case.appealed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("hex")}`;
}

function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Fires one event to every active webhook an org has subscribed for it.
 * Best-effort, fire-and-forget (never await this in a request handler) -
 * a slow or dead endpoint on the receiving end must never block or fail
 * the case-status transition that triggered it. Every attempt is logged
 * to WebhookDelivery regardless of outcome, so a silent failure is still
 * visible to the org afterward.
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
    const body = JSON.stringify(payload);

    await Promise.all(
      webhooks.map(async (webhook) => {
        const signature = signPayload(webhook.secret, body);
        let responseStatus: number | null = null;
        let error: string | null = null;
        try {
          const res = await fetch(webhook.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Anchor-Event": params.event,
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
            event: params.event,
            payload: payload as Prisma.InputJsonValue,
            responseStatus,
            error,
          },
        });
      })
    );
  })().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("webhook dispatch failed:", err instanceof Error ? err.message : err);
  });
}
